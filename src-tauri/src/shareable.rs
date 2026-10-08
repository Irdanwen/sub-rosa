//! What native code may hand to another app: the directories under the app's
//! data root that the share sheet and the photo library read from.
//!
//! Tauri resolves `app_data_dir` on Android to the package's `dataDir`
//! (`/data/user/0/<package>`), not to `filesDir` (`<dataDir>/files`). The
//! gallery and the conversation exports live under the first, so a native
//! check rooted at the second refused every Studio picture and every export
//! it was asked to share. Both sides now name the same directories under the
//! data root: Rust confines a request to them before it invokes the plugin,
//! and `AndroidExports.kt` repeats the check at the Android boundary against
//! the same names, which the test below reads from its source. A scan's PDF
//! has its own share command, confined to its own directory.

use std::path::{Path, PathBuf};

use crate::domain::types::AppError;

/// Studio's gallery, the only source of a shared or saved picture.
pub const GALLERY_DIR: &str = crate::carpe_diem::media::ARTIFACTS_DIR;
/// Where a conversation export is written before the share sheet takes it.
pub const EXPORTS_DIR: &str = "exports";
/// Every directory the Android share sheet may read from.
pub const SHAREABLE_DIRS: [&str; 2] = [GALLERY_DIR, EXPORTS_DIR];

/// The roots `dirs` name under the app's data directory.
pub fn roots(app_data: &Path, dirs: &[&str]) -> Vec<PathBuf> {
    dirs.iter().map(|dir| app_data.join(dir)).collect()
}

/// `requested`, resolved, when it is an existing file under one of `dirs`.
/// Anything else in the data root (the database, preferences, the key
/// material of other features) is refused, as is a path that climbs out.
pub fn confine(
    app_data: &Path,
    dirs: &[&str],
    requested: &Path,
    error_code: &'static str,
    denied_message: &'static str,
) -> Result<PathBuf, AppError> {
    let path = crate::path_confinement::confine_existing(
        &roots(app_data, dirs),
        requested,
        error_code,
        denied_message,
    )?;
    if !path.is_file() {
        return Err(AppError::new(error_code, denied_message));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KOTLIN: &str = include_str!(
        "../android/src/main/java/xyz/carpediem/subrosa/nativebridge/AndroidExports.kt"
    );

    fn data_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        for dir in ["studio-media", "exports", "files", "databases"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        std::fs::write(root.path().join("studio-media/a.png"), b"png").unwrap();
        std::fs::write(root.path().join("exports/chat.md"), b"# chat").unwrap();
        std::fs::write(root.path().join("files/inside-files.png"), b"png").unwrap();
        std::fs::write(root.path().join("databases/june.db"), b"db").unwrap();
        root
    }

    fn check(root: &Path, dirs: &[&str], path: &Path) -> Result<PathBuf, AppError> {
        confine(
            root,
            dirs,
            path,
            "share_file_missing",
            "The file could not be found.",
        )
    }

    #[test]
    fn a_gallery_picture_and_an_export_under_the_data_root_are_shareable() {
        let root = data_root();
        let picture = root.path().join("studio-media/a.png");
        let export = root.path().join("exports/chat.md");
        assert!(check(root.path(), &SHAREABLE_DIRS, &picture).is_ok());
        assert!(check(root.path(), &SHAREABLE_DIRS, &export).is_ok());
        // The photo library takes pictures from the gallery only.
        assert!(check(root.path(), &[GALLERY_DIR], &picture).is_ok());
        assert!(check(root.path(), &[GALLERY_DIR], &export).is_err());
    }

    #[test]
    fn the_rest_of_the_data_root_and_a_climb_out_are_refused() {
        let root = data_root();
        for path in [
            root.path().join("databases/june.db"),
            root.path().join("files/inside-files.png"),
            root.path().join("studio-media/../databases/june.db"),
            root.path().join("studio-media"),
            root.path().join("studio-media/missing.png"),
        ] {
            let refused = check(root.path(), &SHAREABLE_DIRS, &path).unwrap_err();
            assert_eq!(refused.code, "share_file_missing", "{}", path.display());
        }
    }

    #[test]
    fn the_android_boundary_checks_the_same_directories_under_data_dir() {
        for dir in SHAREABLE_DIRS {
            assert!(
                KOTLIN.contains(&format!("\"{dir}\"")),
                "AndroidExports.kt does not name {dir}"
            );
        }
        assert!(KOTLIN.contains("activity.dataDir"));
        // `filesDir` is not where Tauri keeps app data on Android; a check
        // rooted there refuses every gallery file.
        assert!(!KOTLIN.contains("activity.filesDir"));
    }
}
