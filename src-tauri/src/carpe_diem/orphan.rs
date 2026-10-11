//! The backend a previous run left behind.
//!
//! `shutdown` kills the desktop backend when the app quits, but an app that
//! dies without quitting (a crash, a force quit, a panic on a hotkey) never
//! runs it: the `june-api` child is re-parented to launchd and keeps serving
//! on its loopback port, holding the person's Carpe Diem key in memory, until
//! the machine restarts. Four of them were found on one Mac on 2026-10-11.
//!
//! The backend reads its secrets from stdin until EOF and then closes it, so
//! it has no pipe left on which to notice its parent's death, and macOS has no
//! `PR_SET_PDEATHSIG`. So the app keeps a record instead: the child's pid and
//! the path of the executable the system reports for it, written when it
//! starts and removed when it is stopped. A record still present at the next
//! launch names a backend that outlived its app; it is terminated only if that
//! pid still runs the same executable (a reused pid runs something else) and,
//! on unix, if launchd has adopted it (a backend with a living parent belongs
//! to a running app).

use std::path::{Path, PathBuf};

/// The record's file name, in the app's local data directory.
pub(super) const RECORD_FILE: &str = "june-api.pid";

/// One backend this app started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Record {
    pub pid: u32,
    pub exe: PathBuf,
}

impl Record {
    fn serialize(&self) -> String {
        format!("{}\n{}\n", self.pid, self.exe.display())
    }

    fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        let pid = lines.next()?.trim().parse().ok()?;
        let exe = lines.next()?.trim();
        if exe.is_empty() {
            return None;
        }
        Some(Self {
            pid,
            exe: PathBuf::from(exe),
        })
    }
}

/// What the system says about a pid now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Live {
    pub exe: PathBuf,
    /// `None` where the platform does not tell (Windows).
    pub parent: Option<u32>,
}

/// Whether a recorded backend is an orphan to terminate: the same pid still
/// runs the same executable, it is not this process, and, where the platform
/// reports a parent, that parent is launchd (pid 1).
pub(super) fn is_orphan(record: &Record, live: Option<&Live>, own_pid: u32) -> bool {
    let Some(live) = live else {
        return false;
    };
    record.pid != own_pid
        && live.exe == record.exe
        && live.parent.map_or(true, |parent| parent == 1)
}

/// Note the backend just started. Best-effort: a record that cannot be
/// written only means a crash would leave this backend behind, as before.
pub(super) fn remember(path: &Path, pid: u32) {
    let Some(exe) = live(pid).map(|live| live.exe) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, Record { pid, exe }.serialize());
}

/// The backend `pid` was stopped on purpose: drop its record, and only its.
pub(super) fn forget(path: &Path, pid: u32) {
    let recorded = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| Record::parse(&text));
    if recorded.is_some_and(|record| record.pid == pid) {
        let _ = std::fs::remove_file(path);
    }
}

/// At launch, before the first backend starts: terminate the one a previous
/// run left behind, if any, and clear the record. Returns the pid terminated.
pub(super) fn reap(path: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(path).ok()?;
    let _ = std::fs::remove_file(path);
    let record = Record::parse(&text)?;
    if !is_orphan(&record, live(record.pid).as_ref(), std::process::id()) {
        return None;
    }
    terminate(record.pid);
    Some(record.pid)
}

#[cfg(target_os = "macos")]
fn live(pid: u32) -> Option<Live> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is as large as the size passed, and proc_pidpath
    // writes at most that many bytes.
    let length = unsafe {
        libc::proc_pidpath(
            pid,
            buffer.as_mut_ptr().cast::<libc::c_void>(),
            u32::try_from(buffer.len()).ok()?,
        )
    };
    if length <= 0 {
        return None;
    }
    buffer.truncate(usize::try_from(length).ok()?);
    let exe = PathBuf::from(String::from_utf8(buffer).ok()?);

    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    // SAFETY: `info` is a zeroed proc_bsdinfo of exactly `size` bytes, the
    // struct PROC_PIDTBSDINFO fills.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast::<libc::c_void>(),
            size,
        )
    };
    let parent = (written == size).then_some(info.pbi_ppid);
    Some(Live { exe, parent })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn live(pid: u32) -> Option<Live> {
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    // The parent is the fourth field of /proc/<pid>/stat, after the command
    // name, which is parenthesized and may itself hold spaces.
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let parent = stat
        .rsplit_once(')')
        .and_then(|(_, rest)| rest.split_whitespace().nth(1))
        .and_then(|field| field.parse().ok());
    Some(Live { exe, parent })
}

#[cfg(windows)]
fn live(pid: u32) -> Option<Live> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: plain Win32 calls on a handle this function opens and closes.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 32 * 1024];
        let mut length = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        let named = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(handle);
        named.ok()?;
        buffer.truncate(usize::try_from(length).ok()?);
        Some(Live {
            exe: PathBuf::from(String::from_utf16(&buffer).ok()?),
            parent: None,
        })
    }
}

/// Ask the backend to stop, then insist: SIGTERM, up to a second for it to
/// go, then SIGKILL.
#[cfg(unix)]
fn terminate(pid: u32) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    // SAFETY: kill(2) on a pid this module just identified as its own orphan.
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(50));
        // SAFETY: signal 0 only checks that the pid still exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return;
        }
    }
    // SAFETY: as above.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: plain Win32 calls on a handle this function opens and closes.
    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(handle, 1);
            let _ = CloseHandle(handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(pid: u32, exe: &str) -> Record {
        Record {
            pid,
            exe: PathBuf::from(exe),
        }
    }

    fn running(exe: &str, parent: Option<u32>) -> Live {
        Live {
            exe: PathBuf::from(exe),
            parent,
        }
    }

    const EXE: &str = "/Applications/Sub Rosa.app/Contents/MacOS/june-api";

    #[test]
    fn the_record_reads_back_what_it_wrote() {
        let written = record(4242, EXE);
        assert_eq!(Record::parse(&written.serialize()), Some(written));
        assert_eq!(Record::parse(""), None);
        assert_eq!(Record::parse("not a pid\n/x\n"), None);
        assert_eq!(Record::parse("12\n\n"), None);
    }

    #[test]
    fn an_adopted_backend_running_the_recorded_executable_is_an_orphan() {
        assert!(is_orphan(
            &record(10, EXE),
            Some(&running(EXE, Some(1))),
            99
        ));
        // Windows reports no parent: the executable and the pid decide.
        assert!(is_orphan(&record(10, EXE), Some(&running(EXE, None)), 99));
    }

    #[test]
    fn anything_else_is_left_alone() {
        // Gone already.
        assert!(!is_orphan(&record(10, EXE), None, 99));
        // The pid was reused by another program.
        assert!(!is_orphan(
            &record(10, EXE),
            Some(&running("/usr/bin/vim", Some(1))),
            99
        ));
        // Its parent is alive: it belongs to a running app.
        assert!(!is_orphan(
            &record(10, EXE),
            Some(&running(EXE, Some(4000))),
            99
        ));
        // Never this process.
        assert!(!is_orphan(
            &record(99, EXE),
            Some(&running(EXE, Some(1))),
            99
        ));
    }

    #[test]
    fn forget_only_drops_the_record_of_the_backend_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RECORD_FILE);
        std::fs::write(&path, record(10, EXE).serialize()).unwrap();
        forget(&path, 11);
        assert!(path.exists());
        forget(&path, 10);
        assert!(!path.exists());
    }

    /// A real process, orphaned the way a crashed app leaves its backend: a
    /// shell starts `sleep` in the background and exits, so launchd (or init)
    /// adopts it. The record names it; `reap` must end it.
    #[cfg(unix)]
    #[test]
    fn reap_terminates_a_real_orphan_and_spares_a_child_with_a_parent() {
        use std::process::{Command, Stdio};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RECORD_FILE);

        let output = Command::new("/bin/sh")
            .args(["-c", "sleep 30 >/dev/null 2>&1 & echo $!"])
            .stdout(Stdio::piped())
            .output()
            .unwrap();
        let orphan: u32 = String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // Wait until the background job has become `sleep` (a forked shell
        // runs its own image until it execs; `Command::spawn`, which starts
        // the real backend, only returns after the exec) and the exited shell
        // has handed it to launchd (or init).
        let mut adopted = false;
        for _ in 0..80 {
            if live(orphan).is_some_and(|live| {
                live.parent == Some(1) && live.exe.file_name().is_some_and(|name| name == "sleep")
            }) {
                adopted = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        // Inside a sandbox or a container init may not be pid 1; the decision
        // itself is covered above, so only the real path is skipped there.
        if !adopted {
            // SAFETY: cleaning up the process this test started.
            unsafe { libc::kill(orphan as libc::pid_t, libc::SIGKILL) };
            return;
        }
        remember(&path, orphan);
        assert!(path.exists(), "the record was written");
        assert_eq!(reap(&path), Some(orphan));
        // Terminated, it lingers a moment as a zombie until launchd reaps it.
        let gone = (0..80).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(25));
            live(orphan).is_none()
        });
        assert!(gone, "the orphan is gone");
        assert!(!path.exists(), "the record is cleared");

        // A child this test still parents is not an orphan.
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        remember(&path, child.id());
        assert_eq!(reap(&path), None);
        assert!(live(child.id()).is_some(), "the parented child is spared");
        let _ = child.kill();
        let _ = child.wait();
    }
}
