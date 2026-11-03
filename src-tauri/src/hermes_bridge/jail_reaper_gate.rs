//! The only way the jail's reaper signals a process (ADR-0140, addendum of
//! 2026-11-03).
//!
//! In the app, a plain `kill(2)` or `killpg(2)`. In tests, a barrier that
//! does not depend on the code it guards: a signal reaches only a process,
//! a group or a session the test itself created and registered here when it
//! spawned it, or a process (a group's leader) that descends from the test
//! process itself (what the test, or the code it calls, started: a git the
//! app stops on its time limit), which none of the person's applications
//! does. Anything else is not sent; it is noted and fails the test,
//! naming the process it would have hit. A sweep that goes wrong in a test
//! (a mutant that drops "is it the jail's?", say) would otherwise freeze
//! and kill every application of the person whose parent is launchd: the
//! Dock, the Finder, the terminal. That happened, twice.
//!
//! This module is never mutated: the mutation runs check it with `cmp`
//! before and after each mutant.

/// Sends `signal` to `pid`. Whether it was delivered.
#[cfg(unix)]
pub(super) fn kill(pid: u32, signal: libc::c_int) -> bool {
    #[cfg(test)]
    if !barrier::lets(barrier::Target::Process(pid), signal) {
        return false;
    }
    // SAFETY: kill(2) on a pid the caller read from the process table.
    unsafe { libc::kill(pid as libc::pid_t, signal) == 0 }
}

/// Sends `signal` to every member of process group `group`.
#[cfg(unix)]
pub(super) fn killpg(group: u32, signal: libc::c_int) -> bool {
    #[cfg(test)]
    if !barrier::lets(barrier::Target::Group(group), signal) {
        return false;
    }
    // SAFETY: killpg(2) on a group the caller read from the process table.
    unsafe { libc::killpg(group as libc::pid_t, signal) == 0 }
}

#[cfg(all(test, unix))]
pub(super) use barrier::{
    attempts, created_process, created_session, forget_process, forget_session, note_only_here,
    Target,
};

#[cfg(all(test, unix))]
mod barrier {
    use std::cell::{Cell, RefCell};
    use std::collections::HashSet;
    use std::sync::Mutex;

    /// What a signal was aimed at.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Target {
        Process(u32),
        Group(u32),
    }

    /// One signal the reaper tried to send from this thread.
    #[derive(Clone, Debug)]
    pub(crate) struct Attempt {
        pub(crate) target: Target,
        pub(crate) signal: libc::c_int,
        /// When the process (or the group's leader) started, if it runs.
        pub(crate) started: Option<(u64, u64)>,
        pub(crate) sent: bool,
    }

    /// What tests created: pids, and sessions (a session's id is its
    /// leader's pid, and so is the id of the leader's group).
    #[derive(Default)]
    struct Created {
        pids: HashSet<u32>,
        sessions: HashSet<u32>,
    }

    static CREATED: Mutex<Option<Created>> = Mutex::new(None);

    thread_local! {
        static NOTE_ONLY: Cell<bool> = const { Cell::new(false) };
        static ATTEMPTS: RefCell<Vec<Attempt>> = const { RefCell::new(Vec::new()) };
    }

    fn with_created(change: impl FnOnce(&mut Created)) {
        let mut created = CREATED.lock().unwrap_or_else(|e| e.into_inner());
        change(created.get_or_insert_with(Created::default));
    }

    /// Registers a process the test spawned itself.
    pub(crate) fn created_process(pid: u32) {
        with_created(|created| {
            created.pids.insert(pid);
        });
    }

    /// Registers a session (and its leader's group) the test started.
    pub(crate) fn created_session(session: u32) {
        with_created(|created| {
            created.sessions.insert(session);
        });
    }

    /// Forgets a process when its test ends: its pid may be reused.
    pub(crate) fn forget_process(pid: u32) {
        with_created(|created| {
            created.pids.remove(&pid);
        });
    }

    /// Forgets a session when its test ends: its id may be reused.
    pub(crate) fn forget_session(session: u32) {
        with_created(|created| {
            created.sessions.remove(&session);
        });
    }

    /// On this thread, a refused signal is noted, never a panic.
    pub(crate) fn note_only_here(on: bool) {
        NOTE_ONLY.with(|note| note.set(on));
    }

    /// The signals the reaper tried to send from this thread so far.
    pub(crate) fn attempts() -> Vec<Attempt> {
        ATTEMPTS.with(|attempts| attempts.borrow().clone())
    }

    /// Whether the test created `target`. A process that no longer exists
    /// is let through: nothing is there to hit.
    pub(super) fn lets(target: Target, signal: libc::c_int) -> bool {
        let leader = match target {
            Target::Process(pid) | Target::Group(pid) => pid,
        };
        let created = CREATED.lock().unwrap_or_else(|e| e.into_inner());
        let ours = descends_from_this_test(leader)
            || created.as_ref().is_some_and(|created| match target {
                Target::Process(pid) => {
                    // SAFETY: getsid(2) and getpgid(2) only read.
                    let session = unsafe { libc::getsid(pid as libc::pid_t) };
                    let group = unsafe { libc::getpgid(pid as libc::pid_t) };
                    created.pids.contains(&pid)
                        || (session < 0 && group < 0)
                        || created.sessions.contains(&(session as u32))
                        || created.sessions.contains(&(group as u32))
                }
                Target::Group(group) => created.sessions.contains(&group),
            });
        drop(created);
        ATTEMPTS.with(|attempts| {
            attempts.borrow_mut().push(Attempt {
                target,
                signal,
                started: started_of(leader),
                sent: ours,
            })
        });
        if ours {
            return true;
        }
        refuse(target, signal)
    }

    fn refuse(target: Target, signal: libc::c_int) -> bool {
        let what = match target {
            Target::Process(pid) => format!("pid {pid}, comm {}", name_of(pid)),
            Target::Group(group) => format!("group {group}, leader comm {}", name_of(group)),
        };
        let verb = match signal {
            libc::SIGSTOP => "frozen",
            libc::SIGKILL => "killed",
            libc::SIGCONT => "resumed",
            _ => "signalled",
        };
        let line = format!("the reaper would have {verb} {what}");
        eprintln!("JAIL GATE REFUSED: {line}");
        // `SUBROSA_GATE_NOTE_ONLY=1` (a whole-suite census) or a thread
        // that asked for it: noted, never a panic.
        let note_only = NOTE_ONLY.with(|note| note.get())
            || std::env::var_os("SUBROSA_GATE_NOTE_ONLY").is_some();
        if !note_only {
            panic!("{line}");
        }
        false
    }

    /// Whether `pid` runs and descends from this test process.
    fn descends_from_this_test(pid: u32) -> bool {
        let own = std::process::id();
        let mut current = pid;
        for _ in 0..64 {
            match parent_of(current) {
                Some(parent) if parent == own => return true,
                Some(parent) if parent > 1 => current = parent,
                _ => return false,
            }
        }
        false
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
        (read == size && info.pbi_status != 5).then_some(info.pbi_ppid)
    }

    #[cfg(not(target_os = "macos"))]
    fn parent_of(_pid: u32) -> Option<u32> {
        None
    }

    #[cfg(target_os = "macos")]
    fn started_of(pid: u32) -> Option<(u64, u64)> {
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
        (read == size).then_some((info.pbi_start_tvsec, info.pbi_start_tvusec))
    }

    #[cfg(not(target_os = "macos"))]
    fn started_of(_pid: u32) -> Option<(u64, u64)> {
        None
    }

    #[cfg(target_os = "macos")]
    fn name_of(pid: u32) -> String {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer holds 256 bytes.
        let read = unsafe {
            libc::proc_name(
                pid as libc::c_int,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
            )
        };
        if read <= 0 {
            return "?".to_string();
        }
        String::from_utf8_lossy(&buffer[..read as usize]).into_owned()
    }

    #[cfg(not(target_os = "macos"))]
    fn name_of(_pid: u32) -> String {
        "?".to_string()
    }
}
