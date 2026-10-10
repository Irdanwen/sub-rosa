//! Tests that drive a script through a real Python. A machine without
//! `python3` skips them, so a laptop without one still passes; CI must not
//! skip, or a runner image that drops Python turns them into silent passes.

use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Run,
    Skip,
    Fail,
}

fn verdict(found: bool, ci: Option<&str>) -> Verdict {
    if found {
        Verdict::Run
    } else if ci.is_some_and(|value| value.eq_ignore_ascii_case("true") || value == "1") {
        Verdict::Fail
    } else {
        Verdict::Skip
    }
}

/// Whether `python3` runs here. Without it the caller skips `what` and says
/// so, except under `CI=true`, where this panics: the missing interpreter
/// fails the build instead of passing a test that never ran.
pub(crate) fn python3_available(what: &str) -> bool {
    let found = Command::new("python3")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success());
    match verdict(found, std::env::var("CI").ok().as_deref()) {
        Verdict::Run => true,
        Verdict::Skip => {
            eprintln!("python3 not found: {what} is skipped");
            false
        }
        Verdict::Fail => panic!("python3 not found under CI: {what} cannot be skipped there"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_python_skips_locally_and_fails_under_ci() {
        assert_eq!(verdict(true, Some("true")), Verdict::Run);
        assert_eq!(verdict(true, None), Verdict::Run);
        assert_eq!(verdict(false, None), Verdict::Skip);
        assert_eq!(verdict(false, Some("false")), Verdict::Skip);
        assert_eq!(verdict(false, Some("")), Verdict::Skip);
        assert_eq!(verdict(false, Some("true")), Verdict::Fail);
        assert_eq!(verdict(false, Some("TRUE")), Verdict::Fail);
        assert_eq!(verdict(false, Some("1")), Verdict::Fail);
    }
}
