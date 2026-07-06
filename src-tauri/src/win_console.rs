//! Windows console suppression for spawned helper processes.

/// Marks a command so Windows does not open a console window for it.
///
/// Every console-subsystem child (hermes.exe, python.exe, june-api.exe,
/// powershell.exe) spawned from a GUI app otherwise gets its own visible
/// terminal window. CREATE_NO_WINDOW attaches the child to a console that has
/// no window, and the child's own descendants (python spawned by the
/// hermes.exe launcher, MCP servers spawned by the dashboard) inherit that
/// invisible console instead of allocating visible ones — so the whole
/// process tree stays hidden. No-op on the other platforms.
pub fn hide_console(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}
