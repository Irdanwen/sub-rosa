//! Where the relay finds the running app (ADR-0100).
//!
//! Not a port: a Unix domain socket in the app's data folder (owner-only)
//! on macOS and Linux, a named pipe on Windows. Both ends are the same
//! binary, so both compute the address with this one function and cannot
//! disagree; neither reads Tauri's path resolver, which the relay never
//! starts.

use std::path::{Path, PathBuf};

use crate::carpe_diem::branding::BUNDLE_IDENTIFIER;

/// Short on purpose: macOS caps a socket path at 104 bytes.
const SOCKET_FILE: &str = "bx.sock";
pub const MAX_SOCKET_PATH_BYTES: usize = 103;

/// The data folder's name: a debug build keeps its own, like `app_paths`.
fn folder_name(debug: bool) -> String {
    if debug {
        format!("{BUNDLE_IDENTIFIER}-dev")
    } else {
        BUNDLE_IDENTIFIER.to_string()
    }
}

/// The socket for a home folder, on macOS or Linux.
pub fn socket_path_for(
    macos: bool,
    home: &Path,
    xdg_data_home: Option<&Path>,
    debug: bool,
) -> PathBuf {
    let base = if macos {
        home.join("Library/Application Support")
    } else {
        xdg_data_home
            .filter(|dir| dir.is_absolute())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".local/share"))
    };
    base.join(folder_name(debug)).join(SOCKET_FILE)
}

/// This user's socket, when the path fits in a socket address.
#[cfg(unix)]
pub fn socket_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let xdg = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from);
    let path = socket_path_for(
        cfg!(target_os = "macos"),
        &home,
        xdg.as_deref(),
        cfg!(debug_assertions),
    );
    (path.as_os_str().len() <= MAX_SOCKET_PATH_BYTES).then_some(path)
}

/// The pipe for a Windows user. Pipes share one namespace per machine, so
/// the user's name is part of it; without one (an empty or unreadable
/// `USERNAME`) there is no pipe, rather than one name every such account
/// would share. The pipe's DACL (`pipe_security`) is what keeps other users
/// out; the name only keeps two users' apps from colliding.
pub fn pipe_name_for(user: &str, debug: bool) -> Option<String> {
    // Every other character is spelled as its UTF-8 bytes, so two names that
    // differ only in letters a pipe name could not carry stay two pipes.
    let mut spelled = String::new();
    for c in user.trim().chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '.') {
            spelled.push(c);
        } else {
            let mut bytes = [0_u8; 4];
            for byte in c.encode_utf8(&mut bytes).bytes() {
                spelled.push_str(&format!("_{byte:02x}"));
            }
        }
    }
    let spelled: String = spelled.chars().take(160).collect();
    (!spelled.is_empty()).then(|| {
        format!(
            r"\\.\pipe\{}.browser-extension.{spelled}",
            folder_name(debug)
        )
    })
}

#[cfg(windows)]
pub fn pipe_name() -> Option<String> {
    let user = std::env::var("USERNAME").unwrap_or_default();
    pipe_name_for(&user, cfg!(debug_assertions))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_lives_in_the_apps_data_folder() {
        let home = Path::new("/Users/ana");
        assert_eq!(
            socket_path_for(true, home, None, false),
            Path::new("/Users/ana/Library/Application Support/xyz.carpediem.subrosa/bx.sock")
        );
        assert_eq!(
            socket_path_for(false, Path::new("/home/ana"), None, true),
            Path::new("/home/ana/.local/share/xyz.carpediem.subrosa-dev/bx.sock")
        );
        assert_eq!(
            socket_path_for(
                false,
                Path::new("/home/ana"),
                Some(Path::new("/data")),
                false
            ),
            Path::new("/data/xyz.carpediem.subrosa/bx.sock")
        );
        // A relative XDG_DATA_HOME is invalid by the spec and ignored.
        assert_eq!(
            socket_path_for(
                false,
                Path::new("/home/ana"),
                Some(Path::new("data")),
                false
            ),
            Path::new("/home/ana/.local/share/xyz.carpediem.subrosa/bx.sock")
        );
    }

    #[test]
    fn a_typical_mac_path_fits_a_socket_address() {
        let home = Path::new("/Users/a-rather-long-user-name");
        let path = socket_path_for(true, home, None, true);
        assert!(path.as_os_str().len() <= MAX_SOCKET_PATH_BYTES);
    }

    #[test]
    fn the_pipe_is_per_user_and_per_build() {
        assert_eq!(
            pipe_name_for("Ana Smith", false).as_deref(),
            Some(r"\\.\pipe\xyz.carpediem.subrosa.browser-extension.Ana_20Smith")
        );
        assert_ne!(pipe_name_for("ana", true), pipe_name_for("ana", false));
    }

    #[test]
    fn no_user_name_means_no_pipe() {
        assert_eq!(pipe_name_for("", false), None);
        assert_eq!(pipe_name_for("   ", true), None);
        // A name in another script is still that user's own pipe.
        let anna = pipe_name_for("Анна", false).unwrap();
        assert!(
            anna.ends_with(".browser-extension._d0_90_d0_bd_d0_bd_d0_b0"),
            "{anna}"
        );
        assert_ne!(pipe_name_for("Анна", false), pipe_name_for("Анны", false));
        assert!(!pipe_name_for("a\\b", false).unwrap().ends_with("a\\b"));
    }
}
