//! Stops every process a jailed runtime started, not only its process group
//! (ADR-0140, D5).
//!
//! The runtime starts in a session of its own and its teardown kills that
//! process group. A process that left the group with `setsid()` (a server a
//! tool started in the background, say) would survive it, still under the
//! jail but no longer anyone's. So before the group is killed, the app
//! gathers every process descending from the runtime (parent links), every
//! process still in its session, and every process whose environment carries
//! the mark each jailed spawn passes down; then it kills them all.
//!
//! And, for what escapes those three (a double fork that leaves the session,
//! loses its parent and runs an Apple-signed program, whose environment the
//! system hides): every orphan whose profile is the jail's, whoever is
//! responsible for it, which the kernel tells by whether it may look up the
//! jail's marker service and not its canary, asked again until none is left; the system's services the app uses (WebKit's) run under
//! their own profiles and are spared, whatever their name or path.
//!
//! The sweep freezes (`SIGSTOP`) what it finds, with its whole process group
//! when that group lives in a session of the jail's own, looks again until
//! several passes in a row find nothing new or the deadline passes, then
//! kills what it froze and its groups: when it ended quietly, everything it
//! found is stopped, and a stopped process starts nothing. A process that
//! forks and exits in a loop changes pid faster than it can be asked about:
//! it is known by its pid and start time, a pass that asked about a process
//! gone meanwhile proves nothing, and its group, which does not change, is
//! what gets frozen. A frozen parent, unlike a killed one, keeps its
//! children its own until the next pass finds them. The marker is proper
//! to this installation, so a development build beside the installed app
//! neither sweeps nor is swept by the other.
//!
//! What stays open: a process that calls `setsid()` again at every fork,
//! faster than a pass, could outrun the freeze until the deadline. It keeps
//! the jail and none of the app's privacy grants. A jailed process cannot
//! change its profile, so it cannot stop answering as the jail's.

use std::collections::HashMap;
use std::sync::Mutex;

/// The variable that carries the mark.
pub(super) const JAIL_MARK_ENV: &str = "SUBROSA_JAIL_MARK";

/// The mark of each live jailed runtime, by its leader's pid.
static MARKS: Mutex<Option<HashMap<u32, String>>> = Mutex::new(None);

/// A new mark for one jailed spawn. It carries its birth (seconds and
/// microseconds since the epoch): nothing that carries it, nor anything a
/// sweep for it may touch, started before (the belt, see `Belt`), and a
/// record of an earlier run keeps that floor with the mark.
pub(super) fn new_mark() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "jail-{}-{:06}-{}",
        now.as_secs(),
        now.subsec_micros(),
        super::random_token()
    )
}

/// The floor of a sweep for `mark`: its birth, less a second for a clock
/// that stepped. `None` for a mark without one (made before this format):
/// such a sweep signals nothing.
fn mark_floor(mark: &str) -> Option<(u64, u64)> {
    let mut parts = mark.strip_prefix("jail-")?.splitn(3, '-');
    let seconds: u64 = parts.next()?.parse().ok()?;
    let micros: u64 = parts.next()?.parse().ok()?;
    parts.next()?;
    (micros < 1_000_000).then_some((seconds.checked_sub(1)?, micros))
}

/// Remembers the mark of the runtime whose leader is `pid`.
pub(super) fn remember(pid: u32, mark: String) {
    let mut marks = MARKS.lock().unwrap_or_else(|e| e.into_inner());
    marks.get_or_insert_with(HashMap::new).insert(pid, mark);
}

/// The mark of the runtime whose leader is `pid`.
pub(super) fn mark_of(pid: u32) -> Option<String> {
    let marks = MARKS.lock().unwrap_or_else(|e| e.into_inner());
    marks.as_ref().and_then(|marks| marks.get(&pid).cloned())
}

/// What to kill with the jailed runtime whose leader is `pid`, gathered
/// before its group is killed (parents still alive): its descendants, the
/// processes of its session, and those carrying its mark. Empty for a
/// runtime that is not jailed. Forgets the mark.
pub(super) fn doomed_with(pid: u32) -> Doomed {
    let mark = {
        let mut marks = MARKS.lock().unwrap_or_else(|e| e.into_inner());
        marks.as_mut().and_then(|marks| marks.remove(&pid))
    };
    match mark {
        Some(mark) => Doomed {
            pids: gather(pid, &mark),
            mark: Some(mark),
        },
        None => Doomed::default(),
    }
}

/// The processes to kill with a jailed runtime.
#[derive(Debug, Default)]
pub(super) struct Doomed {
    pids: Vec<u32>,
    mark: Option<String>,
}

impl Doomed {
    /// Freezes them, and whatever carries the mark, descends from a frozen
    /// one or is an orphan under this installation's jail, until a pass
    /// finds nothing new; then kills them all. Returns how many.
    pub(super) fn kill(self) -> usize {
        let Some(mark) = self.mark else {
            return 0;
        };
        let floor = mark_floor(&mark);
        sweep(self.pids, Some(&mark), true, floor)
    }
}

/// Kills every process of this account whose environment carries `mark`
/// (a one-off reader's or a sign-in's leftovers), frozen first so none can
/// start another while the sweep runs.
pub(super) fn reap_mark(mark: &str) -> usize {
    sweep(Vec::new(), Some(mark), false, mark_floor(mark))
}

/// Kills every orphan under this installation's jail started since the
/// spawn that made `mark`: after a one-off reader, when no sandboxed
/// runtime is up to own them, and at the app's start for each runtime an
/// earlier run left a record of.
pub(super) fn reap_jailed_orphans(mark: &str) -> usize {
    sweep(Vec::new(), None, true, mark_floor(mark))
}

/// What a jailed runtime of an earlier run left behind, from its record:
/// what carries its mark and the jail's orphans started since. Nothing for
/// a runtime that was not jailed.
pub(super) fn reap_an_earlier_run(mark: Option<&str>) {
    if let Some(mark) = mark {
        reap_mark(mark);
        reap_jailed_orphans(mark);
    }
}

/// How long a sweep may chase processes that keep starting others.
#[cfg(target_os = "macos")]
const SWEEP_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// Passes in a row that find nothing new before a sweep ends.
#[cfg(target_os = "macos")]
const QUIET_PASSES: u32 = 4;

// How long a sweep waits after freezing, as a loaded machine would before
// its next pass (tests only).
#[cfg(all(test, target_os = "macos"))]
thread_local! {
    static PAUSE_BETWEEN_PASSES: std::cell::Cell<std::time::Duration> =
        const { std::cell::Cell::new(std::time::Duration::ZERO) };
}

/// The production belt (ADR-0140, addendum of 2026-11-03), which holds
/// whatever the sweep believes about a process: it never signals pid 1 or
/// below, the app or one of its ancestors, a process of another user, or a
/// process started before the spawn the sweep is for. Without a floor it
/// signals nothing.
#[cfg(target_os = "macos")]
#[derive(Debug)]
struct Belt {
    own: u32,
    ancestors: std::collections::HashSet<u32>,
    uid: u32,
    floor: Option<StartTime>,
}

#[cfg(target_os = "macos")]
impl Belt {
    fn for_this_app(floor: Option<StartTime>) -> Self {
        let own = std::process::id();
        let mut ancestors = std::collections::HashSet::new();
        let mut pid = own;
        while let Some(parent) = parent_of(pid) {
            if parent <= 1 || !ancestors.insert(parent) {
                break;
            }
            pid = parent;
        }
        // SAFETY: getuid(2) cannot fail.
        let uid = unsafe { libc::getuid() };
        Self {
            own,
            ancestors,
            uid,
            floor,
        }
    }

    /// Why the belt refuses `pid`, or `None` when it may be signalled.
    fn refuses(&self, pid: u32, seen: &Seen) -> Option<&'static str> {
        if pid <= 1 {
            Some("pid 1 or below")
        } else if pid == self.own || self.ancestors.contains(&pid) {
            Some("the app or one of its ancestors")
        } else if seen.uid != self.uid {
            Some("another user's")
        } else if self.floor.is_none_or(|floor| seen.started < floor) {
            Some("started before the jailed spawn")
        } else {
            None
        }
    }
}

// Tests only: every process answers as the jail's, as a sweep that lost
// the check would see them (the belt must hold anyway).
#[cfg(all(test, target_os = "macos"))]
thread_local! {
    static FAKE_UNDER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// What links a process to a sweep without asking about it.
#[cfg(target_os = "macos")]
struct Linked<'a> {
    own: u32,
    belt: &'a Belt,
    /// The pids gathered before the sweep (its first pass only).
    initial: &'a [u32],
    frozen: &'a std::collections::HashSet<(u32, StartTime)>,
    frozen_pids: &'a std::collections::BTreeSet<u32>,
    frozen_groups: &'a std::collections::BTreeSet<u32>,
    /// Processes the belt refused, each told once.
    spared: &'a std::cell::RefCell<std::collections::HashSet<(u32, StartTime)>>,
}

/// What one pass of a sweep found.
#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct Pass {
    /// Processes to freeze.
    fresh: Vec<(u32, Seen)>,
    /// A process ended while it was being asked about: it may have started
    /// the next one of a loop, already running, so the pass proves nothing.
    unsure: bool,
}

#[cfg(target_os = "macos")]
impl Pass {
    /// Whether the pass counts toward the quiet ones that end a sweep.
    fn is_quiet(&self) -> bool {
        self.fresh.is_empty() && !self.unsure
    }
}

/// One pass over the process table: what is linked to the sweep (gathered
/// before, child of a frozen process, member of a frozen group) and what
/// `ask` says is wanted (an orphan of the jail, a carrier of the mark).
/// `ask` answers, and whether the process is still the one asked about. A
/// process is known by its pid and start time, so an answer about one that
/// has ended never applies to the next process with its pid.
#[cfg(target_os = "macos")]
fn read_pass(
    table: &[(u32, Seen)],
    linked: &Linked<'_>,
    answers: &mut std::collections::HashMap<(u32, StartTime), bool>,
    ask: &mut dyn FnMut(u32, Seen) -> (bool, bool),
) -> Pass {
    let mut pass = Pass::default();
    for &(pid, seen) in table {
        if pid <= 1 || pid == linked.own || seen.status == SZOMB {
            continue;
        }
        let key = (pid, seen.started);
        if linked.frozen.contains(&key) {
            continue;
        }
        let wanted = linked.initial.contains(&pid)
            || linked.frozen_pids.contains(&seen.parent)
            || linked.frozen_groups.contains(&seen.group)
            || match answers.get(&key) {
                Some(answer) => *answer,
                None => {
                    let (answer, still) = ask(pid, seen);
                    answers.insert(key, answer);
                    pass.unsure |= !still;
                    answer
                }
            };
        if !wanted {
            continue;
        }
        if let Some(reason) = linked.belt.refuses(pid, &seen) {
            if linked.spared.borrow_mut().insert(key) {
                eprintln!("hermes runtime: the jail's sweep spared pid {pid}: {reason}");
            }
            continue;
        }
        pass.fresh.push((pid, seen));
    }
    pass
}

/// Freeze (`SIGSTOP`) everything found, look again, until several passes
/// in a row find nothing new or the deadline passes; then `SIGKILL` every
/// frozen one and its groups.
///
/// A process that forks and exits in a loop lives a few microseconds under
/// each pid: asking about it (its environment, its profile) usually answers
/// about a process already gone. So a process is known by its pid and its
/// start time, never by its pid alone (such a loop goes through pids fast
/// enough to reuse one); an answer about a process that ended while being
/// asked is neither kept nor taken as "not ours", and the pass that met it
/// proves nothing. The first member caught has its whole process group
/// frozen when it lives in a session other than the app's (every jailed
/// spawn starts one, and no process can join a group of another session):
/// the member alive right now is frozen with it, whichever pid it has by
/// then, and a frozen process starts nothing.
#[cfg(target_os = "macos")]
fn sweep(initial: Vec<u32>, mark: Option<&str>, orphans: bool, floor: Option<StartTime>) -> usize {
    use std::collections::{BTreeSet, HashMap, HashSet};
    let own = std::process::id();
    let belt = Belt::for_this_app(floor);
    let spared = std::cell::RefCell::new(HashSet::new());
    // SAFETY: getpgrp(2) and getsid(2) on the app itself cannot fail.
    let own_group = unsafe { libc::getpgrp() } as u32;
    let own_session = unsafe { libc::getsid(0) };
    let needle = mark.map(mark_needle);
    let mut frozen: HashSet<(u32, StartTime)> = HashSet::new();
    // A frozen process cannot end, so its pid stays its own.
    let mut frozen_pids: BTreeSet<u32> = BTreeSet::new();
    let mut frozen_groups: BTreeSet<u32> = BTreeSet::new();
    // Whether a process carries the mark or is an orphan under the jail:
    // asked once per process, so a pass stays fast.
    let mut answers: HashMap<(u32, StartTime), bool> = HashMap::new();
    let mut jailed: HashMap<(u32, StartTime), bool> = HashMap::new();
    let started = std::time::Instant::now();
    let mut first = true;
    let mut quiet = 0;
    loop {
        let table: Vec<(u32, Seen)> = all_pids()
            .into_iter()
            .filter_map(|pid| seen(pid).map(|seen| (pid, seen)))
            .collect();
        let pass = read_pass(
            &table,
            &Linked {
                own,
                belt: &belt,
                spared: &spared,
                initial: if first { &initial[..] } else { &[] },
                frozen: &frozen,
                frozen_pids: &frozen_pids,
                frozen_groups: &frozen_groups,
            },
            &mut answers,
            &mut |pid, seen| {
                let answer = (orphans && orphan_of_the_jail(pid, seen, &mut jailed))
                    || needle
                        .as_deref()
                        .is_some_and(|needle| environment_holds(pid, needle));
                (answer, same_process(pid, seen.started))
            },
        );
        first = false;
        if started.elapsed() > SWEEP_DEADLINE {
            break;
        }
        if pass.is_quiet() {
            quiet += 1;
            if quiet >= QUIET_PASSES {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
            continue;
        }
        quiet = 0;
        let fresh = pass.fresh;
        for (pid, seen) in fresh {
            // SAFETY: getsid(2) on a pid read from the process table.
            let session = unsafe { libc::getsid(pid as libc::pid_t) };
            // A group whose leader the belt refuses is not frozen whole.
            let leader_refused = seen_leader(seen.group)
                .is_some_and(|leader| belt.refuses(seen.group, &leader).is_some());
            if seen.group > 1
                && seen.group != own_group
                && !belt.ancestors.contains(&seen.group)
                && !leader_refused
                && session > 0
                && session != own_session
                && frozen_groups.insert(seen.group)
            {
                super::jail_reaper_gate::killpg(seen.group, libc::SIGSTOP);
            }
            super::jail_reaper_gate::kill(pid, libc::SIGSTOP);
            if same_process(pid, seen.started) {
                frozen.insert((pid, seen.started));
                frozen_pids.insert(pid);
            }
        }
        #[cfg(test)]
        std::thread::sleep(PAUSE_BETWEEN_PASSES.with(|pause| pause.get()));
    }
    // A sweep that ended quietly left every process it found stopped (a
    // member of a frozen group or a child of a frozen process still running
    // is found again, and a pass that finds one is not quiet), and a
    // stopped process starts nothing: one kill each is enough.
    let mut killed = 0;
    for (pid, _) in &frozen {
        if kill_one(*pid) {
            killed += 1;
        }
    }
    for group in &frozen_groups {
        super::jail_reaper_gate::killpg(*group, libc::SIGKILL);
    }
    if killed > 0 {
        eprintln!("hermes runtime: stopped {killed} process(es) its jail had left behind");
    }
    killed
}

#[cfg(not(target_os = "macos"))]
fn sweep(
    _initial: Vec<u32>,
    _mark: Option<&str>,
    _orphans: bool,
    _floor: Option<(u64, u64)>,
) -> usize {
    0
}

#[cfg(target_os = "macos")]
fn mark_needle(mark: &str) -> Vec<u8> {
    format!("{JAIL_MARK_ENV}={mark}\0").into_bytes()
}

/// The runtime's descendants by parent link, the processes of its session
/// (its pid is its session's), and those carrying its mark.
#[cfg(target_os = "macos")]
fn gather(leader: u32, mark: &str) -> Vec<u32> {
    let own = std::process::id();
    let needle = mark_needle(mark);
    let table: Vec<(u32, u32)> = all_pids()
        .into_iter()
        .filter_map(|pid| parent_of(pid).map(|parent| (pid, parent)))
        .collect();
    let mut doomed: Vec<u32> = table
        .iter()
        .filter(|(pid, parent)| {
            // SAFETY: getsid(2) on a pid read from the process table.
            let session = unsafe { libc::getsid(*pid as libc::pid_t) };
            session == leader as libc::pid_t
                || environment_holds(*pid, &needle)
                || (*parent == 1 && runs_under_the_jail(*pid))
        })
        .map(|(pid, _)| *pid)
        .collect();
    let mut frontier = vec![leader];
    frontier.extend(doomed.iter().copied());
    while let Some(parent) = frontier.pop() {
        for (pid, _) in table.iter().filter(|(_, of)| *of == parent) {
            if !doomed.contains(pid) {
                doomed.push(*pid);
                frontier.push(*pid);
            }
        }
    }
    doomed.retain(|pid| *pid != own && *pid != leader);
    doomed
}

#[cfg(not(target_os = "macos"))]
fn gather(_leader: u32, _mark: &str) -> Vec<u32> {
    Vec::new()
}

#[cfg(target_os = "macos")]
extern "C" {
    fn sandbox_check(
        pid: libc::pid_t,
        operation: *const libc::c_char,
        filter: libc::c_int,
        ...
    ) -> libc::c_int;
}

/// Whether `pid` runs under the jail's profile (M2, 7th pass): sandboxed,
/// allowed the jail's marker service and refused its canary. Only the
/// jail's profile allows the marker; a profile that allows everything (a
/// tool's `(allow default)`) also allows the canary and is left alone.
/// Whoever is responsible for the process (it may have disclaimed the app)
/// does not matter. A path asked of another process is answered "denied"
/// whatever its profile, measured; a service name is answered truly.
#[cfg(target_os = "macos")]
pub(super) fn runs_under_the_jail(pid: u32) -> bool {
    #[cfg(test)]
    if FAKE_UNDER.with(|fake| fake.get()) {
        return true;
    }
    const SANDBOX_FILTER_GLOBAL_NAME: libc::c_int = 2;
    const SANDBOX_CHECK_NO_REPORT: libc::c_int = 0x4000_0000;
    let allowed = |name: &str| {
        let Ok(name) = std::ffi::CString::new(name) else {
            return false;
        };
        // SAFETY: the operation and the name are NUL-terminated and outlive
        // the call; the check reads the kernel's answer for that process.
        unsafe {
            sandbox_check(
                pid as libc::pid_t,
                c"mach-lookup".as_ptr(),
                SANDBOX_FILTER_GLOBAL_NAME | SANDBOX_CHECK_NO_REPORT,
                name.as_ptr(),
            ) == 0
        }
    };
    // SAFETY: no operation: only whether a profile applies.
    let sandboxed = unsafe { sandbox_check(pid as libc::pid_t, std::ptr::null(), 0) } > 0;
    sandboxed
        && allowed(&super::sandbox_profile::jail_marker_service())
        && !allowed(super::sandbox_profile::JAIL_CANARY_SERVICE)
}

/// Whether `pid` runs under this installation's jail with no live process
/// outside the jail above it: an orphan of the jail, or a process whose
/// jailed parent is one (a loop that forks and exits leaves its newest pid
/// with a parent still exiting). A process a live runtime started has the
/// runtime above it, whose parent is the app: it is spared.
#[cfg(target_os = "macos")]
fn orphan_of_the_jail(
    pid: u32,
    seen: Seen,
    jailed: &mut std::collections::HashMap<(u32, StartTime), bool>,
) -> bool {
    let (mut pid, mut seen) = (pid, seen);
    for _ in 0..64 {
        let key = (pid, seen.started);
        let under = match jailed.get(&key) {
            Some(under) => *under,
            None => {
                let under = runs_under_the_jail(pid);
                // Not kept about a process that ended while asked.
                if same_process(pid, seen.started) {
                    jailed.insert(key, under);
                }
                under
            }
        };
        if !under {
            return false;
        }
        if seen.parent <= 1 {
            return true;
        }
        match self::seen(seen.parent) {
            // Its parent has ended: it is an orphan already.
            None => return true,
            Some(above) if above.status == SZOMB => return true,
            Some(above) => {
                pid = seen.parent;
                seen = above;
            }
        }
    }
    false
}

/// When a process started, as the kernel tells it (seconds, microseconds).
#[cfg(target_os = "macos")]
type StartTime = (u64, u64);

/// The state of a zombie (`SZOMB`): ended, waiting to be reaped.
#[cfg(target_os = "macos")]
const SZOMB: u32 = 5;

/// What the process table says of one process.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug)]
struct Seen {
    parent: u32,
    group: u32,
    started: StartTime,
    status: u32,
    uid: u32,
}

#[cfg(target_os = "macos")]
fn seen(pid: u32) -> Option<Seen> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the buffer is one `proc_bsdinfo`.
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (read == size).then_some(Seen {
        parent: info.pbi_ppid,
        group: info.pbi_pgid,
        started: (info.pbi_start_tvsec, info.pbi_start_tvusec),
        status: info.pbi_status,
        uid: info.pbi_uid,
    })
}

/// The leader of `group` as the table sees it, when it is still running.
#[cfg(target_os = "macos")]
fn seen_leader(group: u32) -> Option<Seen> {
    seen(group).filter(|leader| leader.group == group)
}

/// Whether `pid` is still the process that started at `started`.
#[cfg(target_os = "macos")]
fn same_process(pid: u32, started: StartTime) -> bool {
    seen(pid).is_some_and(|seen| seen.started == started && seen.status != SZOMB)
}

#[cfg(target_os = "macos")]
fn parent_of(pid: u32) -> Option<u32> {
    seen(pid).map(|seen| seen.parent)
}

#[cfg(unix)]
fn kill_one(pid: u32) -> bool {
    super::jail_reaper_gate::kill(pid, libc::SIGKILL)
}

#[cfg(not(unix))]
fn kill_one(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn all_pids() -> Vec<u32> {
    // SAFETY: a null buffer asks for the count only.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    let mut pids: Vec<libc::c_int> = vec![0; count as usize + 64];
    let size = (pids.len() * std::mem::size_of::<libc::c_int>()) as libc::c_int;
    // SAFETY: the buffer holds `size` bytes.
    let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), size) };
    if filled <= 0 {
        return Vec::new();
    }
    pids.truncate(filled as usize);
    pids.into_iter()
        .filter(|pid| *pid > 0)
        .map(|pid| pid as u32)
        .collect()
}

/// Whether the arguments and environment of `pid` (`KERN_PROCARGS2`, which
/// only a process of the same account may read) hold `needle`.
#[cfg(target_os = "macos")]
fn environment_holds(pid: u32, needle: &[u8]) -> bool {
    // One buffer per thread, reused: a sweep asks about every process
    // several times a second.
    thread_local! {
        static BUFFER: std::cell::RefCell<Vec<u8>> = std::cell::RefCell::new(vec![0u8; 1 << 20]);
    }
    BUFFER.with(|buffer| {
        let mut buffer = buffer.borrow_mut();
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        // The size query answers short; the area is at most `KERN_ARGMAX`.
        let mut size: libc::size_t = buffer.len();
        // SAFETY: the buffer holds `size` bytes.
        let read = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        read == 0
            && buffer[..size.min(buffer.len())]
                .windows(needle.len())
                .any(|window| window == needle)
    })
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    /// Stopping a jailed runtime kills every jailed orphan of the app: the
    /// two tests that make one take turns.
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// ADR-0140 (D5): a grandchild that left the runtime's session with
    /// `setsid()` dies with the runtime all the same.
    #[test]
    fn a_process_that_left_the_session_dies_with_the_runtime() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let mark = new_mark();
        let pid_file = tempfile::NamedTempFile::new().unwrap();
        let mut runtime = std::process::Command::new("/usr/bin/python3");
        runtime
            .args([
                "-I",
                "-c",
                "import os,subprocess,sys,time\np=subprocess.Popen(['/bin/sleep','120'],start_new_session=True)\nopen(sys.argv[1],'w').write(str(p.pid))\ntime.sleep(120)\n",
            ])
            .arg(pid_file.path())
            // Never the harness's pipes: a survivor would hold them open.
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .env(JAIL_MARK_ENV, &mark);
        super::super::sandbox_profile::own_session(&mut runtime);
        let mut runtime = runtime.spawn().unwrap();
        let mut guard = LoopGuard::new(runtime.id(), &mark);
        let mut grandchild = 0u32;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(pid_file.path()) {
                if let Ok(pid) = text.trim().parse() {
                    grandchild = pid;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(grandchild > 0, "the grandchild never started");
        guard.session(grandchild);
        guard.process(grandchild);
        remember(runtime.id(), mark);
        // The runtime's teardown.
        super::super::kill_process_group(runtime.id());
        let _ = runtime.wait();
        // SAFETY: kill(2) with signal 0 only asks whether the pid exists.
        let alive = |pid: u32| unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
        let mut gone = false;
        for _ in 0..40 {
            if !alive(grandchild) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if !gone {
            // SAFETY: cleanup of the test's own process.
            unsafe { libc::kill(grandchild as libc::pid_t, libc::SIGKILL) };
        }
        assert!(gone, "the grandchild outlived the runtime");
        assert_eq!(mark_of(runtime.id()), None);
    }

    /// A profile like the jail's as the reaper sees it: the marker allowed,
    /// the canary refused.
    fn jail_like() -> String {
        format!(
            "(version 1)\n(allow default)\n(deny mach-lookup (global-name \"{}\"))\n",
            super::super::sandbox_profile::JAIL_CANARY_SERVICE
        )
    }

    const DOUBLE_FORK: &str = "import os,sys,time\nif os.fork() == 0:\n    os.setsid()\n    if os.fork() == 0:\n        open(sys.argv[1], 'w').write('%d %d' % (os.getpid(), os.getsid(0)))\n        os.execve(sys.argv[2], [sys.argv[2], '120'], {})\n    os._exit(0)\ntime.sleep(120)\n";

    /// The child gives up the app's responsibility (the private disclaim
    /// attribute) and its session in one `posix_spawn`, with no environment.
    const DISCLAIMED_SPAWN: &str = "import ctypes,os,sys,time\nlibc = ctypes.CDLL(None)\nif os.fork() == 0:\n    attr = ctypes.c_void_p()\n    libc.posix_spawnattr_init(ctypes.byref(attr))\n    d = libc.responsibility_spawnattrs_setdisclaim\n    d.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int]\n    d(ctypes.byref(attr), 1)\n    libc.posix_spawnattr_setflags.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_short]\n    libc.posix_spawnattr_setflags(ctypes.byref(attr), 0x0400)\n    prog = sys.argv[2].encode()\n    argv = (ctypes.c_char_p * 3)(prog, b'120', None)\n    envp = (ctypes.c_char_p * 1)(None)\n    pid = ctypes.c_int()\n    libc.posix_spawn.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_void_p]\n    libc.posix_spawn(ctypes.byref(pid), prog, None, ctypes.byref(attr), argv, envp)\n    open(sys.argv[1], 'w').write(str(pid.value))\n    os._exit(0)\ntime.sleep(120)\n";

    /// A runtime under `profile` whose child double-forks, leaves the
    /// session and execs `program` with an empty environment: an orphan of
    /// launchd without the mark. Returns the runtime and the orphan's pid.
    fn runtime_with_an_orphan(
        profile: &str,
        program: &str,
    ) -> (std::process::Child, u32, String, LoopGuard) {
        runtime_with_an_orphan_by(profile, program, DOUBLE_FORK)
    }

    fn runtime_with_an_orphan_by(
        profile: &str,
        program: &str,
        script: &str,
    ) -> (std::process::Child, u32, String, LoopGuard) {
        let mark = new_mark();
        let pid_file = tempfile::NamedTempFile::new().unwrap();
        let profile_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(profile_file.path(), profile).unwrap();
        let mut runtime = std::process::Command::new(super::super::SANDBOX_EXEC_PATH);
        runtime
            .arg("-f")
            .arg(profile_file.path())
            .args(["/usr/bin/python3", "-I", "-c", script])
            .arg(pid_file.path())
            .arg(program)
            // Never the harness's pipes: a survivor would hold them open.
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .env(JAIL_MARK_ENV, &mark);
        super::super::sandbox_profile::own_session(&mut runtime);
        let runtime = runtime.spawn().unwrap();
        let mut guard = LoopGuard::new(runtime.id(), &mark);
        let mut orphan = 0u32;
        let mut session = None;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(pid_file.path()) {
                // The orphan's pid, then its session's when it gives one.
                let mut parts = text.split_whitespace().map(|part| part.parse::<u32>());
                if let Some(Ok(pid)) = parts.next() {
                    orphan = pid;
                    session = parts.next().and_then(Result::ok);
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(orphan > 0, "the orphan never started");
        guard.process(orphan);
        // A spawn with `POSIX_SPAWN_SETSID` leads its own session; a double
        // fork's session is its vanished middle process's.
        guard.session(session.unwrap_or(orphan));
        for _ in 0..40 {
            if parent_of(orphan) == Some(1) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(parent_of(orphan), Some(1), "not an orphan");
        (runtime, orphan, mark, guard)
    }

    /// Stops the runtime as the app does; whether `orphan` died with it.
    fn stop_and_check(mut runtime: std::process::Child, orphan: u32, mark: String) -> bool {
        remember(runtime.id(), mark);
        super::super::kill_process_group(runtime.id());
        let _ = runtime.wait();
        // SAFETY: kill(2) with signal 0 only asks whether the pid exists.
        let alive = |pid: u32| unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
        for _ in 0..40 {
            if !alive(orphan) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // SAFETY: cleanup of the test's own process.
        unsafe { libc::kill(orphan as libc::pid_t, libc::SIGKILL) };
        false
    }

    /// ADR-0140 (F1): a double fork that leaves the session, loses its
    /// parent and runs an Apple-signed program with an empty environment
    /// dies with the runtime too.
    #[test]
    fn an_orphan_apple_program_without_the_mark_dies_with_the_runtime() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let (runtime, orphan, mark, _guard) = runtime_with_an_orphan(&jail_like(), "/bin/sleep");
        assert!(
            stop_and_check(runtime, orphan, mark),
            "the orphan outlived the runtime"
        );
    }

    /// ADR-0140 (M2): a program copied under a name ending in `.xpc` dies
    /// too: the reaper looks at the profile, not the path.
    #[test]
    fn an_orphan_named_like_an_xpc_service_dies_with_the_runtime() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("wait.c");
        std::fs::write(
            &source,
            "#include <unistd.h>\nint main(void){for(;;)pause();}\n",
        )
        .unwrap();
        let program = dir.path().join("a.xpc/Contents/MacOS/a");
        std::fs::create_dir_all(program.parent().unwrap()).unwrap();
        let built = std::process::Command::new("/usr/bin/cc")
            .arg(&source)
            .arg("-o")
            .arg(&program)
            .status();
        if !built.is_ok_and(|status| status.success()) {
            eprintln!("no C compiler here; skipped");
            return;
        }
        let (runtime, orphan, mark, _guard) =
            runtime_with_an_orphan(&jail_like(), &program.to_string_lossy());
        assert!(
            stop_and_check(runtime, orphan, mark),
            "the .xpc copy outlived the runtime"
        );
    }

    /// 7th pass: an orphan that gave up the app's responsibility (disclaim)
    /// and its session in one spawn, with no environment, dies too.
    #[test]
    fn a_disclaimed_orphan_dies_with_the_runtime() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let (runtime, orphan, mark, _guard) =
            runtime_with_an_orphan_by(&jail_like(), "/bin/sleep", DISCLAIMED_SPAWN);
        assert!(
            stop_and_check(runtime, orphan, mark),
            "the disclaimed orphan outlived the runtime"
        );
    }

    /// 7th pass: a tool's profile that allows everything is not the jail's.
    #[test]
    fn an_orphan_under_an_allow_everything_profile_is_spared() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let (runtime, orphan, mark, _guard) =
            runtime_with_an_orphan("(version 1)\n(allow default)\n", "/bin/sleep");
        assert!(
            !stop_and_check(runtime, orphan, mark),
            "an allow-everything orphan was killed"
        );
    }

    /// Final pass: a process that forks and exits in a tight loop (a new
    /// pid as fast as the system gives one) is frozen with its group, then
    /// killed, with everything it started: found by the mark it carries.
    #[test]
    fn a_process_that_keeps_changing_pid_dies_with_the_runtime() {
        a_looping_process_dies(true);
    }

    /// The same loop without the mark (its environment emptied): found only
    /// as an orphan under the jail.
    #[test]
    fn a_looping_orphan_of_the_jail_dies_with_the_runtime() {
        a_looping_process_dies(false);
    }

    fn a_looping_process_dies(marked: bool) {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let loop_script = "import os,sys,time\nif os.fork() == 0:\n    os.setsid()\n    open(sys.argv[1], 'w').write(str(os.getpid()))\n    while True:\n        if os.fork():\n            os._exit(0)\ntime.sleep(120)\n";
        let mark = new_mark();
        let sid_file = tempfile::NamedTempFile::new().unwrap();
        let profile_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(profile_file.path(), jail_like()).unwrap();
        let mut runtime = std::process::Command::new(super::super::SANDBOX_EXEC_PATH);
        runtime
            .arg("-f")
            .arg(profile_file.path())
            .args(["/usr/bin/python3", "-I", "-c", loop_script])
            .arg(sid_file.path())
            .env_clear()
            // Never the harness's pipes: a survivor would hold them open.
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if marked {
            runtime.env(JAIL_MARK_ENV, &mark);
        }
        super::super::sandbox_profile::own_session(&mut runtime);
        let mut runtime = runtime.spawn().unwrap();
        // Whatever happens next, the loop dies with the test.
        let mut guard = LoopGuard::new(runtime.id(), &mark);
        let mut sid = 0i32;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(sid_file.path()) {
                if let Ok(value) = text.trim().parse() {
                    sid = value;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(sid > 0, "the loop never started");
        guard.session(sid as u32);
        std::thread::sleep(std::time::Duration::from_millis(300));
        remember(runtime.id(), mark);
        super::super::kill_process_group(runtime.id());
        let _ = runtime.wait();
        // What is left in the loop's session and still running (a killed
        // process waits a moment to be reaped by launchd).
        let running_in_session = || -> Vec<(u32, Seen)> {
            all_pids()
                .into_iter()
                // SAFETY: getsid(2) on pids read from the process table.
                .filter(|pid| unsafe { libc::getsid(*pid as libc::pid_t) } == sid)
                .filter_map(|pid| seen(pid).map(|seen| (pid, seen)))
                .filter(|(_, seen)| seen.status != SZOMB)
                .collect()
        };
        let mut left = running_in_session();
        for _ in 0..40 {
            if left.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            left = running_in_session();
        }
        assert!(left.is_empty(), "the looping process survived: {left:?}");
    }

    /// The start sweep spares what a live runtime started: a jailed process
    /// whose jailed parent's parent is the app is nobody's orphan.
    #[test]
    fn a_live_runtimes_processes_are_spared() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let script = "import os,sys,time\nchild = os.fork()\nif child == 0:\n    time.sleep(120)\n    os._exit(0)\nopen(sys.argv[1], 'w').write(str(child))\ntime.sleep(120)\n";
        let mark = new_mark();
        let pid_file = tempfile::NamedTempFile::new().unwrap();
        let profile_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(profile_file.path(), jail_like()).unwrap();
        let mut runtime = std::process::Command::new(super::super::SANDBOX_EXEC_PATH);
        runtime
            .arg("-f")
            .arg(profile_file.path())
            .args(["/usr/bin/python3", "-I", "-c", script])
            .arg(pid_file.path())
            .env_clear()
            .env(JAIL_MARK_ENV, &mark)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        super::super::sandbox_profile::own_session(&mut runtime);
        let mut runtime = runtime.spawn().unwrap();
        let _guard = LoopGuard::new(runtime.id(), &mark);
        let mut child = 0u32;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(pid_file.path()) {
                if let Ok(value) = text.trim().parse() {
                    child = value;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(child > 0, "the runtime never started its child");
        assert!(runs_under_the_jail(child), "the child is not jailed");
        reap_jailed_orphans(&mark);
        let alive = seen(child).is_some_and(|seen| seen.status != SZOMB);
        super::super::kill_process_group(runtime.id());
        let _ = runtime.wait();
        assert!(alive, "the start sweep killed a live runtime's process");
    }

    /// A pass that asked about a process gone meanwhile proves nothing: the
    /// process may have started the next one of a loop, already running.
    /// Deterministic: the question is answered by a stand-in.
    #[test]
    fn a_pass_that_met_a_process_gone_while_asked_is_not_quiet() {
        let table = [(
            4242,
            Seen {
                parent: 1,
                group: 4242,
                started: (1, 2),
                status: 2,
                uid: 501,
            },
        )];
        let (frozen, frozen_pids, frozen_groups) = Default::default();
        let belt = Belt {
            own: 1000,
            ancestors: Default::default(),
            uid: 501,
            floor: Some((0, 0)),
        };
        let spared = Default::default();
        let linked = Linked {
            own: 1000,
            belt: &belt,
            spared: &spared,
            initial: &[],
            frozen: &frozen,
            frozen_pids: &frozen_pids,
            frozen_groups: &frozen_groups,
        };
        let mut answers = HashMap::new();
        let gone = read_pass(&table, &linked, &mut answers, &mut |_, _| (false, false));
        assert!(gone.fresh.is_empty());
        assert!(
            !gone.is_quiet(),
            "a pass that met a process gone while asked counted as quiet"
        );
        // The same process, asked again and still there, is a quiet pass.
        let mut answers = HashMap::new();
        let still = read_pass(&table, &linked, &mut answers, &mut |_, _| (false, true));
        assert!(still.is_quiet());
        // And a later process under the same pid is asked again.
        let mut asked = 0;
        let later = [(
            4242,
            Seen {
                started: (3, 4),
                ..table[0].1
            },
        )];
        read_pass(&later, &linked, &mut answers, &mut |_, _| {
            asked += 1;
            (true, true)
        });
        assert_eq!(asked, 1, "an answer about an ended process was reused");
    }

    /// The child of an orphan of the jail is one too, while its parent is
    /// alive: the newest pid of a loop that forks and exits has a parent
    /// still exiting. Deterministic: both live until the test ends.
    #[test]
    fn the_child_of_an_orphan_of_the_jail_is_one() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        // The runtime starts an orphan (it exits), whose child sleeps.
        let script = "import os,sys,time\nif os.fork() == 0:\n    child = os.fork()\n    if child == 0:\n        time.sleep(120)\n        os._exit(0)\n    open(sys.argv[1], 'w').write('%d %d' % (os.getpid(), child))\n    time.sleep(120)\n    os._exit(0)\nos._exit(0)\n";
        let mark = new_mark();
        let pid_file = tempfile::NamedTempFile::new().unwrap();
        let profile_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(profile_file.path(), jail_like()).unwrap();
        let mut runtime = std::process::Command::new(super::super::SANDBOX_EXEC_PATH);
        runtime
            .arg("-f")
            .arg(profile_file.path())
            .args(["/usr/bin/python3", "-I", "-c", script])
            .arg(pid_file.path())
            .env_clear()
            .env(JAIL_MARK_ENV, &mark)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        super::super::sandbox_profile::own_session(&mut runtime);
        let mut runtime = runtime.spawn().unwrap();
        let _guard = LoopGuard::new(runtime.id(), &mark);
        let mut pids = (0u32, 0u32);
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(pid_file.path()) {
                let parts: Vec<u32> = text.split(' ').filter_map(|p| p.parse().ok()).collect();
                if let [orphan, child] = parts[..] {
                    pids = (orphan, child);
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let (orphan, child) = pids;
        assert!(orphan > 0 && child > 0, "the orphan never started");
        let _ = runtime.wait();
        for _ in 0..40 {
            if parent_of(orphan) == Some(1) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(parent_of(orphan), Some(1), "not an orphan");
        assert_eq!(parent_of(child), Some(orphan));
        let mut jailed = HashMap::new();
        let orphan_seen = seen(orphan).unwrap();
        let child_seen = seen(child).unwrap();
        assert!(orphan_of_the_jail(orphan, orphan_seen, &mut jailed));
        assert!(
            orphan_of_the_jail(child, child_seen, &mut jailed),
            "the child of an orphan of the jail was not taken for one"
        );
    }

    /// A one-off reader's leftover that left its session and dropped the
    /// mark dies with its marked parent: the parent is frozen, not killed,
    /// so the child stays its child until the next pass finds it there.
    /// Killed first, the parent would hand it to launchd, unmarked and out
    /// of reach (there is no orphan search for a reader's leftovers).
    #[test]
    fn a_child_that_dropped_the_mark_dies_with_its_frozen_parent() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let script = "import os,sys,time\nchild = os.fork()\nif child == 0:\n    os.setsid()\n    os.execve('/bin/sleep', ['/bin/sleep', '120'], {})\nopen(sys.argv[1], 'w').write(str(child))\ntime.sleep(120)\n";
        let mark = new_mark();
        let pid_file = tempfile::NamedTempFile::new().unwrap();
        let mut reader = std::process::Command::new("/usr/bin/python3");
        reader
            .args(["-I", "-c", script])
            .arg(pid_file.path())
            .env_clear()
            .env(JAIL_MARK_ENV, &mark)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        super::super::sandbox_profile::own_session(&mut reader);
        let mut reader = reader.spawn().unwrap();
        let mut guard = LoopGuard::new(reader.id(), &mark);
        let mut child = 0u32;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(pid_file.path()) {
                if let Ok(pid) = text.trim().parse() {
                    child = pid;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(child > 0, "the child never started");
        guard.session(child);
        // Until the child runs `sleep`, without the mark.
        let needle = mark_needle(&mark);
        for _ in 0..40 {
            if !environment_holds(child, &needle) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            !environment_holds(child, &needle),
            "the child kept the mark"
        );
        // A loaded machine: the next pass comes after the parent, were it
        // killed, would have handed the child to launchd.
        PAUSE_BETWEEN_PASSES.with(|pause| pause.set(std::time::Duration::from_millis(300)));
        reap_mark(&mark);
        PAUSE_BETWEEN_PASSES.with(|pause| pause.set(std::time::Duration::ZERO));
        let _ = reader.wait();
        let mut gone = false;
        for _ in 0..40 {
            if seen(child).is_none_or(|seen| seen.status == SZOMB) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(gone, "the child that dropped the mark outlived the sweep");
    }

    /// A member of a marked process's group that is neither marked nor its
    /// child (an orphan of launchd that dropped the mark) dies with the
    /// group, frozen whole.
    #[test]
    fn an_unmarked_member_of_a_found_group_dies_with_it() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let script = "import os,sys,time\na = os.fork()\nif a == 0:\n    b = os.fork()\n    if b == 0:\n        time.sleep(0.3)\n        os.execve('/bin/sleep', ['/bin/sleep', '120'], {})\n    open(sys.argv[1], 'w').write(str(b))\n    os._exit(0)\nos.waitpid(a, 0)\ntime.sleep(120)\n";
        let mark = new_mark();
        let pid_file = tempfile::NamedTempFile::new().unwrap();
        let mut reader = std::process::Command::new("/usr/bin/python3");
        reader
            .args(["-I", "-c", script])
            .arg(pid_file.path())
            .env_clear()
            .env(JAIL_MARK_ENV, &mark)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        super::super::sandbox_profile::own_session(&mut reader);
        let mut reader = reader.spawn().unwrap();
        let _guard = LoopGuard::new(reader.id(), &mark);
        let mut member = 0u32;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(pid_file.path()) {
                if let Ok(pid) = text.trim().parse() {
                    member = pid;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(member > 0, "the member never started");
        let needle = mark_needle(&mark);
        for _ in 0..40 {
            if parent_of(member) == Some(1) && !environment_holds(member, &needle) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(parent_of(member), Some(1), "not an orphan");
        assert!(
            !environment_holds(member, &needle),
            "the member kept the mark"
        );
        assert_eq!(seen(member).map(|seen| seen.group), Some(reader.id()));
        reap_mark(&mark);
        let _ = reader.wait();
        let mut gone = false;
        for _ in 0..40 {
            if seen(member).is_none_or(|seen| seen.status == SZOMB) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(gone, "an unmarked member of the group outlived the sweep");
    }

    /// A mark carries its birth; one without it (made before this format)
    /// gives no floor, and a sweep without a floor signals nothing.
    #[test]
    fn a_mark_carries_its_floor() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let (seconds, _) = mark_floor(&new_mark()).expect("a new mark has a floor");
        assert!(
            seconds + 1 >= now && seconds <= now,
            "floor {seconds}, now {now}"
        );
        assert_eq!(mark_floor("jail-3f9a0c"), None);
        assert_eq!(mark_floor("jail-12-1000000-x"), None);
        assert_eq!(mark_floor("jail-12-5"), None);
        assert_eq!(mark_floor("jail-12-000005-x"), Some((11, 5)));
    }

    /// The belt, one guard at a time: whatever a sweep believes, it never
    /// signals pid 1, the app or an ancestor, another user's process, one
    /// started before the spawn, or anything when it has no floor.
    #[test]
    fn the_belt_refuses_each_process_it_guards() {
        let belt = Belt {
            own: 1000,
            ancestors: [900].into_iter().collect(),
            uid: 501,
            floor: Some((100, 0)),
        };
        let later = Seen {
            parent: 1,
            group: 2000,
            started: (100, 5),
            status: 2,
            uid: 501,
        };
        assert_eq!(belt.refuses(2000, &later), None);
        assert!(belt.refuses(1, &later).is_some(), "pid 1");
        assert!(belt.refuses(1000, &later).is_some(), "the app");
        assert!(belt.refuses(900, &later).is_some(), "an ancestor");
        let other_user = Seen { uid: 0, ..later };
        assert!(belt.refuses(2000, &other_user).is_some(), "another user");
        let earlier = Seen {
            started: (99, 999_999),
            ..later
        };
        assert!(belt.refuses(2000, &earlier).is_some(), "started before");
        let no_floor = Belt {
            floor: None,
            ..belt
        };
        assert!(no_floor.refuses(2000, &later).is_some(), "no floor");
    }

    /// A process that carries a mark but started before the mark's spawn
    /// is spared; one started after dies.
    #[test]
    fn a_marked_process_older_than_its_mark_is_spared() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Born two seconds from now: its floor is one second from now.
        let mark = format!("jail-{}-000000-{}", now + 2, super::super::random_token());
        let spawn = |mark: &str| {
            // Not `/bin/sleep`: the system hides an Apple program's
            // environment, mark included.
            let mut sleeper = std::process::Command::new("/usr/bin/python3");
            sleeper
                .args(["-I", "-c", "import time\ntime.sleep(120)\n"])
                .env_clear()
                .env(JAIL_MARK_ENV, mark)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            super::super::sandbox_profile::own_session(&mut sleeper);
            sleeper.spawn().unwrap()
        };
        let mut older = spawn(&mark);
        let mut guard = LoopGuard::new(older.id(), &mark);
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let mut newer = spawn(&mark);
        guard.session(newer.id());
        // Until `/usr/bin/python3` (an Apple shim, its environment hidden)
        // has become the interpreter, whose environment shows the mark.
        let needle = mark_needle(&mark);
        for id in [older.id(), newer.id()] {
            for _ in 0..60 {
                if environment_holds(id, &needle) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            assert!(environment_holds(id, &needle), "the mark is not readable");
        }
        assert!(seen(older.id()).unwrap().started < mark_floor(&mark).unwrap());
        assert!(seen(newer.id()).unwrap().started >= mark_floor(&mark).unwrap());
        reap_mark(&mark);
        let mut newer_gone = false;
        for _ in 0..40 {
            if newer.try_wait().unwrap().is_some() {
                newer_gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let older_alive = older.try_wait().unwrap().is_none();
        let _ = older.kill();
        let _ = older.wait();
        let _ = newer.kill();
        let _ = newer.wait();
        assert!(older_alive, "a process older than its mark was killed");
        assert!(newer_gone, "a process newer than its mark lived");
    }

    /// The dangerous mutant, as a test: every process answers as the
    /// jail's. Behind the barrier (note only, on this thread), the sweep
    /// never aims at a process older than the spawn, spares the test's own
    /// older orphan, and still kills the newer one.
    #[test]
    fn a_sweep_that_takes_every_process_for_the_jails_touches_nothing_older() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let (old_runtime, old, _old_mark, _old_guard) =
            runtime_with_an_orphan(&jail_like(), "/bin/sleep");
        std::thread::sleep(std::time::Duration::from_millis(1200));
        let (new_runtime, new, mark, _new_guard) =
            runtime_with_an_orphan(&jail_like(), "/bin/sleep");
        let floor = mark_floor(&mark).unwrap();
        assert!(seen(old).unwrap().started < floor);
        super::super::jail_reaper_gate::note_only_here(true);
        FAKE_UNDER.with(|fake| fake.set(true));
        reap_jailed_orphans(&mark);
        FAKE_UNDER.with(|fake| fake.set(false));
        super::super::jail_reaper_gate::note_only_here(false);
        let attempts = super::super::jail_reaper_gate::attempts();
        let old_alive = seen(old).is_some_and(|seen| seen.status != SZOMB);
        let mut new_gone = false;
        for _ in 0..40 {
            if seen(new).is_none_or(|seen| seen.status == SZOMB) {
                new_gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        for runtime in [old_runtime, new_runtime] {
            let mut runtime = runtime;
            super::super::kill_process_group(runtime.id());
            let _ = runtime.wait();
        }
        let older: Vec<_> = attempts
            .iter()
            .filter(|attempt| attempt.started.is_some_and(|started| started < floor))
            .collect();
        assert!(
            older.is_empty(),
            "aimed at processes older than the spawn: {older:?}"
        );
        use super::super::jail_reaper_gate::Target;
        assert!(
            !attempts
                .iter()
                .any(|attempt| attempt.target == Target::Process(old)),
            "aimed at the older orphan"
        );
        assert!(
            attempts
                .iter()
                .any(|attempt| attempt.target == Target::Process(new)
                    && attempt.signal == libc::SIGSTOP
                    && attempt.sent),
            "never froze the newer orphan"
        );
        assert!(old_alive, "the older orphan was killed");
        assert!(new_gone, "the newer orphan outlived the sweep");
    }

    /// Kills a looping test process for good, whatever the test's outcome:
    /// its sessions (the loop's group and session never change) and what
    /// carries its mark are frozen and killed until, several passes in a
    /// row, none of them is left running.
    /// It also registers with the test barrier (`jail_reaper_gate`) what the
    /// test created, and forgets it at the end (a pid may be reused).
    struct LoopGuard {
        sessions: Vec<i32>,
        pids: Vec<u32>,
        needle: Vec<u8>,
    }

    impl LoopGuard {
        fn new(session: u32, mark: &str) -> Self {
            let mut guard = Self {
                sessions: Vec::new(),
                pids: Vec::new(),
                needle: mark_needle(mark),
            };
            guard.session(session);
            guard
        }

        /// A session (and its leader's group) the test started.
        fn session(&mut self, session: u32) {
            super::super::jail_reaper_gate::created_session(session);
            self.sessions.push(session as i32);
        }

        /// A process the test started.
        fn process(&mut self, pid: u32) {
            super::super::jail_reaper_gate::created_process(pid);
            self.pids.push(pid);
        }
    }

    impl Drop for LoopGuard {
        fn drop(&mut self) {
            for pid in &self.pids {
                // SAFETY: kill(2) on a process the test started.
                unsafe {
                    libc::kill(*pid as libc::pid_t, libc::SIGKILL);
                }
            }
            let own = std::process::id();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            let mut quiet = 0;
            while quiet < 4 && std::time::Instant::now() < deadline {
                let mut running = false;
                for pid in all_pids() {
                    if pid <= 1 || pid == own {
                        continue;
                    }
                    let Some(seen) = seen(pid) else {
                        continue;
                    };
                    // SAFETY: getsid(2) on a pid read from the process table.
                    let session = unsafe { libc::getsid(pid as libc::pid_t) };
                    if seen.status != SZOMB
                        && (self.sessions.contains(&session)
                            || environment_holds(pid, &self.needle))
                    {
                        running = true;
                        if self.sessions.contains(&session) {
                            // SAFETY: killpg(2) on a session of the test's
                            // loop, seen running right now: its leader's
                            // group, never the harness's.
                            unsafe {
                                libc::killpg(session, libc::SIGSTOP);
                                libc::killpg(session, libc::SIGKILL);
                            }
                        }
                        // SAFETY: kill(2) on a process of the test's loop.
                        unsafe {
                            libc::kill(pid as libc::pid_t, libc::SIGSTOP);
                            libc::kill(pid as libc::pid_t, libc::SIGKILL);
                        }
                    }
                }
                if running {
                    quiet = 0;
                } else {
                    quiet += 1;
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
            }
            for session in &self.sessions {
                super::super::jail_reaper_gate::forget_session(*session as u32);
            }
            for pid in &self.pids {
                super::super::jail_reaper_gate::forget_process(*pid);
            }
        }
    }

    /// ADR-0140 (M2): an orphan of the app under another profile (as the
    /// system's WebKit services are) is spared.
    #[test]
    fn an_orphan_under_another_profile_is_spared() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        // As WebKit's profiles do: a list of services, not the jail's marker.
        let other = "(version 1)\n(allow default)\n(deny mach-lookup)\n(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\"))\n";
        let (runtime, orphan, mark, _guard) = runtime_with_an_orphan(other, "/bin/sleep");
        assert!(
            !stop_and_check(runtime, orphan, mark),
            "an orphan of another profile was killed"
        );
    }
}
