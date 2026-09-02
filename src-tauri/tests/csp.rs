//! The content security policy is a property, not a config line.
//!
//! `script-src 'self' 'sha256-…'` is what makes a model-authored
//! `javascript:` href inert, which is most of why the markdown renderers can
//! be as simple as they are. It sits in a JSON file nobody reads on the way
//! past, and every directive in it is one somebody could widen in a hurry —
//! `'unsafe-eval'` to make a charting library work, a `*` to unblock an image
//! host — with no failing test and no visible symptom.
//!
//! Two things are checked. That the directives which do the work are still
//! there and still narrow. And that the **iOS** config does not quietly
//! override them: `tauri.ios.conf.json` merges over the base, so a `csp` key
//! appearing there would replace the whole policy on the phone, where nothing
//! else would notice.

use std::collections::BTreeMap;

fn read_json(path: &str) -> serde_json::Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|_| panic!("could not read {path}"));
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("{path} is not valid JSON"))
}

/// The base policy, split into `directive -> sources`.
fn directives() -> BTreeMap<String, Vec<String>> {
    let config = read_json("tauri.conf.json");
    let csp = config["app"]["security"]["csp"]
        .as_str()
        .expect("app.security.csp must be a string");
    csp.split(';')
        .filter_map(|part| {
            let mut words = part.split_whitespace();
            let name = words.next()?.to_string();
            Some((name, words.map(str::to_string).collect()))
        })
        .collect()
}

#[test]
fn the_policy_still_has_the_directives_that_do_the_work() {
    let policy = directives();
    for name in [
        "default-src",
        "script-src",
        "style-src",
        "img-src",
        "connect-src",
        "object-src",
        "base-uri",
        "frame-ancestors",
    ] {
        assert!(
            policy.contains_key(name),
            "{name} disappeared from the CSP; every one of these is load-bearing"
        );
    }
}

#[test]
fn script_execution_stays_pinned_to_this_bundle() {
    let policy = directives();
    let script_src = policy.get("script-src").expect("script-src");

    assert!(
        script_src.contains(&"'self'".to_string()),
        "script-src must keep 'self'"
    );
    assert!(
        script_src
            .iter()
            .any(|source| source.starts_with("'sha256-")),
        "script-src must keep its pinned hash: {script_src:?}"
    );
    for forbidden in ["'unsafe-eval'", "'unsafe-inline'", "*", "data:", "blob:"] {
        assert!(
            !script_src.contains(&forbidden.to_string()),
            "script-src must not allow {forbidden}. This is what makes a \
             javascript: href from the model inert (see src/lib/external-link.ts)."
        );
    }
    // A remote origin in script-src would let a compromised page load code.
    assert!(
        !script_src.iter().any(|source| source.contains("//")),
        "script-src must name no remote origin: {script_src:?}"
    );
}

#[test]
fn the_page_cannot_be_framed_reparented_or_asked_to_run_a_plugin() {
    let policy = directives();
    assert_eq!(
        policy.get("object-src"),
        Some(&vec!["'none'".to_string()]),
        "object-src must stay 'none'"
    );
    assert_eq!(
        policy.get("base-uri"),
        Some(&vec!["'none'".to_string()]),
        "base-uri must stay 'none': a rewritten <base> retargets every relative URL"
    );
    assert_eq!(
        policy.get("frame-ancestors"),
        Some(&vec!["'none'".to_string()]),
        "frame-ancestors must stay 'none'"
    );
}

#[test]
fn network_reach_stays_local() {
    let policy = directives();
    let connect_src = policy.get("connect-src").expect("connect-src");

    // Loopback is the sidecar's random port, which is why this is broader than
    // one would like. What it must never become is open.
    for forbidden in ["*", "https:", "http:", "ws:", "wss:"] {
        assert!(
            !connect_src.contains(&forbidden.to_string()),
            "connect-src must not allow the bare {forbidden}: {connect_src:?}"
        );
    }
    for source in connect_src {
        let is_local = source.starts_with("'")
            || source.starts_with("ipc:")
            || source.contains("127.0.0.1")
            || source.contains("ipc.localhost");
        assert!(
            is_local,
            "connect-src source {source} is not loopback or IPC; every host the \
             webview can reach is one an XSS could probe"
        );
    }
}

#[test]
fn the_ios_config_does_not_replace_the_policy() {
    // Tauri merges `tauri.ios.conf.json` over the base. A `csp` key here would
    // replace the whole policy on the phone, and no desktop test would notice.
    let ios = read_json("tauri.ios.conf.json");
    assert!(
        ios["app"]["security"]["csp"].is_null(),
        "tauri.ios.conf.json must not set app.security.csp; the base policy has \
         to apply on iOS too"
    );
}

#[test]
fn the_asset_scope_names_only_what_the_app_writes() {
    let config = read_json("tauri.conf.json");
    let scope = config["app"]["security"]["assetProtocol"]["scope"]
        .as_array()
        .expect("assetProtocol.scope must be an array");
    assert!(
        !scope.is_empty(),
        "an empty scope would be a silent opening"
    );
    for entry in scope {
        let entry = entry.as_str().expect("scope entries are strings");
        assert!(
            entry.starts_with('$'),
            "asset scope {entry} must be rooted at an app directory variable, \
             not an absolute path"
        );
        assert!(
            !entry.contains(".."),
            "asset scope {entry} must not climb out of its root"
        );
    }
}
