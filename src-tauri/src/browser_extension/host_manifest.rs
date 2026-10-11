//! The native messaging host registration, per browser and per system
//! (ADR-0100).
//!
//! A browser starts a native messaging host only when a manifest naming it
//! sits where that browser looks: a folder per browser on macOS and Linux, a
//! registry key per browser on Windows (pointing at a manifest file the app
//! keeps in its data directory). The manifest says which executable to start
//! (the app's own, see `relay`) and which extensions may start it. Writing
//! one is all "registering" means; removing it is all "disconnecting" means.
//! Both are per user: nothing here needs an installer or an administrator.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The name the extension passes to `runtime.connectNative`. Lowercase,
/// dots only, as both browser families require.
pub const HOST_NAME: &str = "xyz.carpediem.subrosa";

/// Chromium extension ids a release build lets start the host: the ids the
/// stores assign on first upload, each added here before the release that
/// ships it (docs/browser-extension.md). Empty until the extension is
/// published, so a release build answers no Chromium extension yet.
pub const STORE_CHROMIUM_EXTENSION_IDS: &[&str] = &[];

/// The id the `key` in `browser-extension/manifest.json` pins for an unpacked
/// install. That key is public, so anyone can load an extension under this
/// id: only a development build answers it, or one built with
/// `SUBROSA_ALLOW_UNPACKED_EXTENSION=1` for testing the unpacked extension.
pub const UNPACKED_CHROMIUM_EXTENSION_ID: &str = "aphalahbhpimjbfdkjkdfgfbohboceig";

/// Whether this build answers the unpacked extension.
pub fn unpacked_allowed() -> bool {
    cfg!(debug_assertions) || option_env!("SUBROSA_ALLOW_UNPACKED_EXTENSION") == Some("1")
}

/// The Chromium ids allowed to start the host, by whether the unpacked one is.
pub fn chromium_extension_ids_for(allow_unpacked: bool) -> Vec<&'static str> {
    let mut ids = STORE_CHROMIUM_EXTENSION_IDS.to_vec();
    if allow_unpacked && !ids.contains(&UNPACKED_CHROMIUM_EXTENSION_ID) {
        ids.push(UNPACKED_CHROMIUM_EXTENSION_ID);
    }
    ids
}

/// The Chromium ids this build lets start the host.
pub fn chromium_extension_ids() -> Vec<&'static str> {
    chromium_extension_ids_for(unpacked_allowed())
}

/// The origins the relay may report for this build, exactly as it reports
/// them (`relay::invoked_as_host`). The manifest already limits who the
/// browser starts the host for; the app checks again when a connection
/// names its origin, so a process that reaches the socket some other way
/// cannot claim another one.
pub fn allowed_origins() -> Vec<String> {
    allowed_origins_for(&chromium_extension_ids())
}

pub fn allowed_origins_for(chromium_ids: &[&str]) -> Vec<String> {
    chromium_ids
        .iter()
        .map(|id| chromium_origin(id))
        .chain(std::iter::once(format!(
            "moz-extension:{GECKO_EXTENSION_ID}"
        )))
        .collect()
}

fn chromium_origin(id: &str) -> String {
    format!("chrome-extension://{id}/")
}

/// The Firefox add-on id, set in the extension's manifest
/// (`browser_specific_settings.gecko.id`), so it is the same everywhere.
pub const GECKO_EXTENSION_ID: &str = "browser-extension@subrosa.carpediem.xyz";

const DESCRIPTION: &str = "Sub Rosa browser extension host";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Browser {
    Chrome,
    Edge,
    Brave,
    Firefox,
}

impl Browser {
    pub const ALL: [Browser; 4] = [Self::Chrome, Self::Edge, Self::Brave, Self::Firefox];

    pub fn id(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Edge => "edge",
            Self::Brave => "brave",
            Self::Firefox => "firefox",
        }
    }

    /// Brand names, not translated.
    pub fn label(self) -> &'static str {
        match self {
            Self::Chrome => "Google Chrome",
            Self::Edge => "Microsoft Edge",
            Self::Brave => "Brave",
            Self::Firefox => "Firefox",
        }
    }

    fn is_gecko(self) -> bool {
        matches!(self, Self::Firefox)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    MacOs,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// The manifest for `browser`, starting `exe`.
pub fn manifest_json(browser: Browser, exe: &Path) -> serde_json::Value {
    let mut manifest = serde_json::json!({
        "name": HOST_NAME,
        "description": DESCRIPTION,
        "path": exe.to_string_lossy(),
        "type": "stdio",
    });
    if browser.is_gecko() {
        manifest["allowed_extensions"] = serde_json::json!([GECKO_EXTENSION_ID]);
    } else {
        manifest["allowed_origins"] = chromium_extension_ids()
            .iter()
            .map(|id| chromium_origin(id))
            .collect();
    }
    manifest
}

/// The folder a browser reads host manifests from, on systems where it is a
/// folder (`None` on Windows, where it is a registry key).
pub fn manifest_dir(os: Os, browser: Browser, home: &Path) -> Option<PathBuf> {
    let relative = match (os, browser) {
        (Os::Windows, _) => return None,
        (Os::MacOs, Browser::Chrome) => {
            "Library/Application Support/Google/Chrome/NativeMessagingHosts"
        }
        (Os::MacOs, Browser::Edge) => {
            "Library/Application Support/Microsoft Edge/NativeMessagingHosts"
        }
        (Os::MacOs, Browser::Brave) => {
            "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        }
        (Os::MacOs, Browser::Firefox) => "Library/Application Support/Mozilla/NativeMessagingHosts",
        (Os::Linux, Browser::Chrome) => ".config/google-chrome/NativeMessagingHosts",
        (Os::Linux, Browser::Edge) => ".config/microsoft-edge/NativeMessagingHosts",
        (Os::Linux, Browser::Brave) => ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
        (Os::Linux, Browser::Firefox) => ".mozilla/native-messaging-hosts",
    };
    Some(home.join(relative))
}

/// The registry key (under `HKEY_CURRENT_USER`) a browser reads on Windows.
pub fn registry_key(browser: Browser) -> String {
    let base = match browser {
        Browser::Chrome => r"Software\Google\Chrome",
        Browser::Edge => r"Software\Microsoft\Edge",
        Browser::Brave => r"Software\BraveSoftware\Brave-Browser",
        Browser::Firefox => r"Software\Mozilla",
    };
    format!(r"{base}\NativeMessagingHosts\{HOST_NAME}")
}

/// Where a browser keeps its profiles: present means installed and run at
/// least once, which is what registering for it needs.
pub fn profile_dir(
    os: Os,
    browser: Browser,
    home: &Path,
    local_app_data: Option<&Path>,
    app_data: Option<&Path>,
) -> Option<PathBuf> {
    Some(match (os, browser) {
        (Os::MacOs, Browser::Chrome) => home.join("Library/Application Support/Google/Chrome"),
        (Os::MacOs, Browser::Edge) => home.join("Library/Application Support/Microsoft Edge"),
        (Os::MacOs, Browser::Brave) => {
            home.join("Library/Application Support/BraveSoftware/Brave-Browser")
        }
        (Os::MacOs, Browser::Firefox) => home.join("Library/Application Support/Firefox"),
        (Os::Linux, Browser::Chrome) => home.join(".config/google-chrome"),
        (Os::Linux, Browser::Edge) => home.join(".config/microsoft-edge"),
        (Os::Linux, Browser::Brave) => home.join(".config/BraveSoftware/Brave-Browser"),
        (Os::Linux, Browser::Firefox) => home.join(".mozilla/firefox"),
        (Os::Windows, Browser::Chrome) => local_app_data?.join(r"Google\Chrome\User Data"),
        (Os::Windows, Browser::Edge) => local_app_data?.join(r"Microsoft\Edge\User Data"),
        (Os::Windows, Browser::Brave) => {
            local_app_data?.join(r"BraveSoftware\Brave-Browser\User Data")
        }
        (Os::Windows, Browser::Firefox) => app_data?.join(r"Mozilla\Firefox"),
    })
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Whether `browser` looks installed for this user.
pub fn is_installed(browser: Browser) -> bool {
    let Some(home) = home_dir() else {
        return false;
    };
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    profile_dir(
        Os::current(),
        browser,
        &home,
        local.as_deref(),
        roaming.as_deref(),
    )
    .is_some_and(|dir| dir.is_dir())
}

/// Where the manifest file for `browser` is written. On Windows it lives in
/// the app's data directory and the registry points at it.
fn manifest_path(browser: Browser, data_dir: &Path) -> Option<PathBuf> {
    let file = format!("{HOST_NAME}.json");
    match Os::current() {
        Os::Windows => Some(
            data_dir
                .join("native-messaging")
                .join(browser.id())
                .join(file),
        ),
        os => manifest_dir(os, browser, &home_dir()?).map(|dir| dir.join(file)),
    }
}

/// Writes (or rewrites) the manifest for `browser`, pointing at `exe`.
pub fn install(browser: Browser, exe: &Path, data_dir: &Path) -> std::io::Result<PathBuf> {
    let path = manifest_path(browser, data_dir)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home directory"))?;
    write_manifest(&path, browser, exe)?;
    #[cfg(windows)]
    reg(&[
        "add",
        &format!(r"HKCU\{}", registry_key(browser)),
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        &path.to_string_lossy(),
        "/f",
    ])?;
    Ok(path)
}

/// Writes the manifest file itself, whole or not at all.
fn write_manifest(path: &Path, browser: Browser, exe: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(&manifest_json(browser, exe))?;
    let staging = path.with_extension("json.part");
    std::fs::write(&staging, bytes)?;
    std::fs::rename(&staging, path)
}

/// Removes what [`install`] wrote. Missing pieces are not an error.
pub fn uninstall(browser: Browser, data_dir: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // `reg delete` fails on a key that is not there, which is the state
        // we want; only the file removal below reports errors.
        let _ = reg(&["delete", &format!(r"HKCU\{}", registry_key(browser)), "/f"]);
    }
    if let Some(path) = manifest_path(browser, data_dir) {
        match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(windows)]
fn reg(args: &[&str]) -> std::io::Result<()> {
    let mut command = std::process::Command::new("reg.exe");
    command.args(args);
    crate::win_console::hide_console(&mut command);
    let status = command.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "reg.exe exited with {status}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_manifests_name_origins_and_firefox_names_the_add_on() {
        let exe = Path::new("/Applications/Sub Rosa.app/Contents/MacOS/os-june");
        let chrome = manifest_json(Browser::Chrome, exe);
        assert_eq!(chrome["name"], HOST_NAME);
        assert_eq!(chrome["type"], "stdio");
        assert_eq!(
            chrome["path"],
            "/Applications/Sub Rosa.app/Contents/MacOS/os-june"
        );
        assert_eq!(
            chrome["allowed_origins"],
            serde_json::json!(chromium_extension_ids()
                .iter()
                .map(|id| format!("chrome-extension://{id}/"))
                .collect::<Vec<_>>())
        );
        assert!(chrome.get("allowed_extensions").is_none());
        let firefox = manifest_json(Browser::Firefox, exe);
        assert_eq!(firefox["allowed_extensions"][0], GECKO_EXTENSION_ID);
        assert!(firefox.get("allowed_origins").is_none());
    }

    #[test]
    fn the_host_name_is_one_both_browser_families_accept() {
        assert!(HOST_NAME
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_'));
        assert!(!HOST_NAME.starts_with('.') && !HOST_NAME.ends_with('.'));
    }

    #[test]
    fn manifests_go_where_each_browser_looks() {
        let home = Path::new("/home/ana");
        assert_eq!(
            manifest_dir(Os::MacOs, Browser::Brave, home).unwrap(),
            home.join(
                "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
            )
        );
        assert_eq!(
            manifest_dir(Os::Linux, Browser::Firefox, home).unwrap(),
            home.join(".mozilla/native-messaging-hosts")
        );
        assert!(manifest_dir(Os::Windows, Browser::Chrome, home).is_none());
        assert_eq!(
            registry_key(Browser::Edge),
            r"Software\Microsoft\Edge\NativeMessagingHosts\xyz.carpediem.subrosa"
        );
        assert_eq!(
            registry_key(Browser::Firefox),
            r"Software\Mozilla\NativeMessagingHosts\xyz.carpediem.subrosa"
        );
    }

    #[test]
    fn windows_browsers_are_found_under_the_users_app_data() {
        let local = Path::new(r"C:\Users\ana\AppData\Local");
        let roaming = Path::new(r"C:\Users\ana\AppData\Roaming");
        let home = Path::new(r"C:\Users\ana");
        assert_eq!(
            profile_dir(Os::Windows, Browser::Edge, home, Some(local), Some(roaming)).unwrap(),
            local.join(r"Microsoft\Edge\User Data")
        );
        assert_eq!(
            profile_dir(
                Os::Windows,
                Browser::Firefox,
                home,
                Some(local),
                Some(roaming)
            )
            .unwrap(),
            roaming.join(r"Mozilla\Firefox")
        );
        assert!(profile_dir(Os::Windows, Browser::Chrome, home, None, None).is_none());
    }

    /// The id an unpacked install gets is derived from the manifest's `key`;
    /// the host must allow exactly that id, or pairing fails with a message
    /// about a host that "is not allowed".
    #[test]
    fn the_pinned_chromium_id_matches_the_extension_manifest_key() {
        use base64::Engine as _;
        use sha2::{Digest, Sha256};
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../browser-extension/manifest.json")).unwrap();
        let key = base64::engine::general_purpose::STANDARD
            .decode(manifest["key"].as_str().unwrap())
            .unwrap();
        let id: String = Sha256::digest(&key)[..16]
            .iter()
            .flat_map(|byte| [byte >> 4, byte & 0x0f])
            .map(|nibble| char::from(b'a' + nibble))
            .collect();
        assert_eq!(id, UNPACKED_CHROMIUM_EXTENSION_ID);
        assert_eq!(
            manifest["browser_specific_settings"]["gecko"]["id"],
            GECKO_EXTENSION_ID
        );
    }

    /// The unpacked id is derived from a public key: a release build does
    /// not answer it, a development build does, and the stores' ids are the
    /// release list.
    #[test]
    fn a_release_build_answers_only_the_store_ids() {
        assert!(!chromium_extension_ids_for(false).contains(&UNPACKED_CHROMIUM_EXTENSION_ID));
        assert_eq!(
            chromium_extension_ids_for(false),
            STORE_CHROMIUM_EXTENSION_IDS
        );
        assert!(chromium_extension_ids_for(true).contains(&UNPACKED_CHROMIUM_EXTENSION_ID));
        assert_eq!(
            unpacked_allowed(),
            cfg!(debug_assertions) || option_env!("SUBROSA_ALLOW_UNPACKED_EXTENSION") == Some("1")
        );
        let release = allowed_origins_for(&chromium_extension_ids_for(false));
        assert!(!release
            .iter()
            .any(|origin| origin.contains(UNPACKED_CHROMIUM_EXTENSION_ID)));
        assert!(release.contains(&format!("moz-extension:{GECKO_EXTENSION_ID}")));
    }

    #[test]
    fn a_manifest_is_written_whole_where_it_is_asked() {
        let home = tempfile::tempdir().unwrap();
        let dir = manifest_dir(Os::MacOs, Browser::Chrome, home.path()).unwrap();
        let path = dir.join(format!("{HOST_NAME}.json"));
        write_manifest(&path, Browser::Chrome, Path::new("/bin/x")).unwrap();
        let read: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(read["path"], "/bin/x");
        assert!(!path.with_extension("json.part").exists());
    }
}
