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
//! system hides): every orphan the app is responsible for whose profile is
//! the jail's, which the kernel tells by whether it may look up the jail's
//! marker service; the system's services the app uses (WebKit's) run under
//! their own profiles and are spared, whatever their name or path.
//!
//! What stays out of reach: a process that also gave up the app's
//! responsibility (a spawn with the private disclaim attribute). It still
//! runs under the jail, with none of the app's privacy grants (ADR-0140,
//! D2), and nothing restarts it.

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
    // The app is its own responsible process when the system started it;
    // started from a terminal (development), the terminal is.
    // SAFETY: a pid in, a pid out.
    let responsible_for_app =
        unsafe { responsibility_get_pid_responsible_for_pid(own as libc::pid_t) } as u32;
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
                || (*parent == 1 && jailed_orphan_of_this_app(*pid, responsible_for_app))
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
    fn responsibility_get_pid_responsible_for_pid(pid: libc::pid_t) -> libc::pid_t;
}

/// An orphan whose responsible process is the app's (`app`) and that runs
/// under the jail's own profile (M2). The kernel is asked whether that
/// process may look up the jail's marker service, a name only the jail's
/// profiles allow (and no service holds). The system's XPC services the app
/// uses (WebKit's) run under their own profiles and are spared, whatever
/// their path; a copy of a program under a name ending in `.xpc` is not.
#[cfg(target_os = "macos")]
fn jailed_orphan_of_this_app(pid: u32, app: u32) -> bool {
    // SAFETY: a pid in, a pid out.
    let responsible = unsafe { responsibility_get_pid_responsible_for_pid(pid as libc::pid_t) };
    responsible == app as libc::pid_t && runs_under_the_jail(pid)
}

/// Whether `pid` runs under the jail's profile: sandboxed, and allowed the
/// marker service. (A path asked of another process is answered "denied"
/// whatever its profile, measured; a service name is answered truly.)
#[cfg(target_os = "macos")]
pub(super) fn runs_under_the_jail(pid: u32) -> bool {
    const SANDBOX_FILTER_GLOBAL_NAME: libc::c_int = 2;
    const SANDBOX_CHECK_NO_REPORT: libc::c_int = 0x4000_0000;
    let Ok(marker) = std::ffi::CString::new(super::sandbox_profile::JAIL_MARKER_SERVICE) else {
        return false;
    };
    // SAFETY: the operation and the name are NUL-terminated and outlive the
    // call; the check reads the kernel's answer for that process.
    let (sandboxed, marked) = unsafe {
        (
            sandbox_check(pid as libc::pid_t, std::ptr::null(), 0),
            sandbox_check(
                pid as libc::pid_t,
                c"mach-lookup".as_ptr(),
                SANDBOX_FILTER_GLOBAL_NAME | SANDBOX_CHECK_NO_REPORT,
                marker.as_ptr(),
            ),
        )
    };
    sandboxed > 0 && marked == 0
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

    /// A runtime under `profile` whose child double-forks, leaves the
    /// session and execs `program` with an empty environment: an orphan of
    /// launchd without the mark. Returns the runtime and the orphan's pid.
    fn runtime_with_an_orphan(profile: &str, program: &str) -> (std::process::Child, u32, String) {
        let mark = new_mark();
        let pid_file = tempfile::NamedTempFile::new().unwrap();
        let profile_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(profile_file.path(), profile).unwrap();
        let mut runtime = std::process::Command::new(super::super::SANDBOX_EXEC_PATH);
        runtime
            .arg("-f")
            .arg(profile_file.path())
            .args([
                "/usr/bin/python3",
                "-I",
                "-c",
                "import os,sys,time\nif os.fork() == 0:\n    os.setsid()\n    if os.fork() == 0:\n        open(sys.argv[1], 'w').write(str(os.getpid()))\n        os.execve(sys.argv[2], [sys.argv[2], '120'], {})\n    os._exit(0)\ntime.sleep(120)\n",
            ])
            .arg(pid_file.path())
            .arg(program)
            .env(JAIL_MARK_ENV, &mark);
        super::super::sandbox_profile::own_session(&mut runtime);
        let runtime = runtime.spawn().unwrap();
        let mut orphan = 0u32;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(pid_file.path()) {
                if let Ok(pid) = text.trim().parse() {
                    orphan = pid;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(orphan > 0, "the orphan never started");
        for _ in 0..40 {
            if parent_of(orphan) == Some(1) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(parent_of(orphan), Some(1), "not an orphan");
        (runtime, orphan, mark)
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
        let (runtime, orphan, mark) =
            runtime_with_an_orphan("(version 1)\n(allow default)\n", "/bin/sleep");
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
        let (runtime, orphan, mark) =
            runtime_with_an_orphan("(version 1)\n(allow default)\n", &program.to_string_lossy());
        assert!(
            stop_and_check(runtime, orphan, mark),
            "the .xpc copy outlived the runtime"
        );
    }

    /// ADR-0140 (M2): an orphan of the app under another profile (as the
    /// system's WebKit services are) is spared.
    #[test]
    fn an_orphan_under_another_profile_is_spared() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        // As WebKit's profiles do: a list of services, not the jail's marker.
        let other = "(version 1)\n(allow default)\n(deny mach-lookup)\n(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\"))\n";
        let (runtime, orphan, mark) = runtime_with_an_orphan(other, "/bin/sleep");
        assert!(
            !stop_and_check(runtime, orphan, mark),
            "an orphan of another profile was killed"
        );
    }
}
