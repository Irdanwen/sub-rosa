//! `subrosa-code`: a code run without a window. Everything lives in the
//! library (`os_june_lib::code::cli`, ADR-0123); this file only hands it the
//! command line. Built with `--features code-cli`, which keeps it out of the
//! app bundle (Tauri bundles every binary whose features are enabled).

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn main() {
    std::process::exit(os_june_lib::code::cli::main());
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn main() {}
