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
//! What stays out of reach: a process that left the session, whose parent
//! is already gone, and whose environment the system does not show or no
//! longer carries the mark (an Apple-signed program started with `env -i`
//! through a double fork). It still runs under the jail, with none of the
//! app's privacy grants (ADR-0140, D2), and nothing restarts it.

use std::collections::HashMap;
use std::sync::Mutex;

/// The variable that carries the mark.
pub(super) const JAIL_MARK_ENV: &str = "SUBROSA_JAIL_MARK";

/// The mark of each live jailed runtime, by its leader's pid.
static MARKS: Mutex<Option<HashMap<u32, String>>> = Mutex::new(None);

/// A new mark for one jailed spawn.
pub(super) fn new_mark() -> String {
    format!("jail-{}", super::random_token())
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
    /// Kills them, then whatever still carries the mark. Returns how many.
    pub(super) fn kill(self) -> usize {
        let mut killed = 0;
        for pid in self.pids {
            if kill_one(pid) {
                killed += 1;
            }
        }
        if let Some(mark) = self.mark {
            killed += reap_mark(&mark);
        }
        killed
    }
}

/// Kills every process of this account whose environment carries `mark`,
/// until none is left (a process may start another while it is killed).
#[cfg(target_os = "macos")]
pub(super) fn reap_mark(mark: &str) -> usize {
    let needle = mark_needle(mark);
    let own = std::process::id();
    let mut killed = 0;
    for _ in 0..5 {
        let found: Vec<u32> = all_pids()
            .into_iter()
            .filter(|pid| *pid != own && environment_holds(*pid, &needle))
            .collect();
        if found.is_empty() {
            break;
        }
        for pid in found {
            if kill_one(pid) {
                killed += 1;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if killed > 0 {
        eprintln!("hermes runtime: stopped {killed} process(es) its jail had left behind");
    }
    killed
}

#[cfg(not(target_os = "macos"))]
pub(super) fn reap_mark(_mark: &str) -> usize {
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
        .map(|(pid, _)| *pid)
        .filter(|pid| {
            // SAFETY: getsid(2) on a pid read from the process table.
            let session = unsafe { libc::getsid(*pid as libc::pid_t) };
            session == leader as libc::pid_t || environment_holds(*pid, &needle)
        })
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
fn parent_of(pid: u32) -> Option<u32> {
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
    (read == size).then_some(info.pbi_ppid)
}

#[cfg(unix)]
fn kill_one(pid: u32) -> bool {
    // SAFETY: kill(2) with a pid read from the process table.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) == 0 }
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
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    // The size query answers short; the area is at most `KERN_ARGMAX`.
    let mut size: libc::size_t = 1 << 20;
    let mut buffer = vec![0u8; size];
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
    if read != 0 {
        return false;
    }
    buffer.truncate(size);
    buffer.windows(needle.len()).any(|window| window == needle)
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    /// ADR-0140 (D5): a grandchild that left the runtime's session with
    /// `setsid()` dies with the runtime all the same.
    #[test]
    fn a_process_that_left_the_session_dies_with_the_runtime() {
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
            .env(JAIL_MARK_ENV, &mark);
        super::super::sandbox_profile::own_session(&mut runtime);
        let mut runtime = runtime.spawn().unwrap();
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
}
