#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by a browser as its native messaging host (ADR-0100): relay to
    // the running app and exit, before anything of the app starts.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if let Some(origin) = os_june_lib::browser_extension::invoked_as_host(std::env::args_os()) {
        std::process::exit(os_june_lib::browser_extension::run_host(origin));
    }
    os_june_lib::run();
}
