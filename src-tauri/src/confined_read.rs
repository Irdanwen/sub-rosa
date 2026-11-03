//! Reading, from outside the jail, a file the jail can write (ADR-0140,
//! addendum of 2026-11-03, second pass).
//!
//! The council and the code review read a session's working folder, and the
//! Files panel its workspace, as the app: with the person's rights, outside
//! the jail. The jail writes those folders, links included, so a file there
//! may be a link to what the jail itself cannot read (`leak.md ->
//! ~/.ssh/id_ed25519`), a folder on the way may be a link, and a "file" may
//! be a pipe that never answers. Measured: the council read a key through
//! such a link and sent it to its seats.
//!
//! So every such read opens the path one component at a time from a folder
//! held open, never following a link (`openat` with `O_NOFOLLOW`), takes
//! only a regular file, and reads at most a bound. Nothing here resolves a
//! path first and opens it later: there is no moment a link could be put in.
//!
//! Kept small on purpose: `code/confined.rs` (the code plan's branch) does
//! the same for its own reads; the two are meant to become one at the merge
//! (FORK_NOTES).

use std::io::Read as _;
use std::path::{Component, Path};

/// Why a confined read gave nothing.
#[derive(Debug)]
pub enum Refused {
    /// A component of the path is a link.
    Link,
    /// The path is not a plain relative path (`..`, an absolute part).
    NotPlain,
    /// The last component is not a regular file (a folder, a pipe, a
    /// device, a socket).
    NotAFile,
    /// The file holds more than the bound.
    TooLarge,
    /// Any other failure, missing file included.
    Io(std::io::Error),
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Link => write!(f, "a link is on the way"),
            Refused::NotPlain => write!(f, "not a plain path"),
            Refused::NotAFile => write!(f, "not a regular file"),
            Refused::TooLarge => write!(f, "larger than the reading limit"),
            Refused::Io(error) => write!(f, "{error}"),
        }
    }
}

/// The bytes of the regular file at `relative` under `root`, at most
/// `limit` of them (more refuses the file). `root` is the folder the person
/// picked; it is resolved once, and nothing under it is followed.
pub fn read_beneath(root: &Path, relative: &Path, limit: u64) -> Result<Vec<u8>, Refused> {
    let file = open_beneath(root, relative)?;
    read_bounded(file, limit, false).map(|(bytes, _)| bytes)
}

/// The first `limit` bytes of the regular file at `relative` under `root`,
/// and whether there was more.
pub fn read_prefix_beneath(
    root: &Path,
    relative: &Path,
    limit: u64,
) -> Result<(Vec<u8>, bool), Refused> {
    let file = open_beneath(root, relative)?;
    read_bounded(file, limit, true)
}

/// The bytes of the regular file at `path`, an absolute path already
/// resolved (`canonicalize`) and checked by the caller: every component is
/// opened again from `/` without following a link, so one put in since the
/// check is refused rather than followed.
pub fn read_resolved(path: &Path, limit: u64) -> Result<Vec<u8>, Refused> {
    let relative = path.strip_prefix("/").map_err(|_| Refused::NotPlain)?;
    read_beneath(Path::new("/"), relative, limit)
}

/// `read_resolved`, with a file past `limit` read as none.
pub fn read_resolved_within(path: &Path, limit: u64) -> std::io::Result<Option<Vec<u8>>> {
    match read_resolved(path, limit) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(Refused::TooLarge) => Ok(None),
        Err(error) => Err(std::io::Error::other(error.to_string())),
    }
}

/// Copies the regular file at `path` (resolved and checked by the caller,
/// as for `read_resolved`) to `to`, a destination the person chose,
/// streaming: a workspace file can be large.
pub fn copy_resolved(path: &Path, to: &Path) -> Result<u64, Refused> {
    let relative = path.strip_prefix("/").map_err(|_| Refused::NotPlain)?;
    let mut from = open_beneath(Path::new("/"), relative)?;
    let mut to = std::fs::File::create(to).map_err(Refused::Io)?;
    std::io::copy(&mut from, &mut to).map_err(Refused::Io)
}

fn plain_components(relative: &Path) -> Result<Vec<&std::ffi::OsStr>, Refused> {
    let mut names = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(name) => names.push(name),
            Component::CurDir => {}
            _ => return Err(Refused::NotPlain),
        }
    }
    if names.is_empty() {
        return Err(Refused::NotPlain);
    }
    Ok(names)
}

#[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
fn open_beneath(root: &Path, relative: &Path) -> Result<std::fs::File, Refused> {
    use std::os::fd::{FromRawFd as _, OwnedFd};
    use std::os::unix::ffi::OsStrExt as _;

    let names = plain_components(relative)?;
    let root = std::fs::canonicalize(root).map_err(Refused::Io)?;
    let root_c =
        std::ffi::CString::new(root.as_os_str().as_bytes()).map_err(|_| Refused::NotPlain)?;
    let open = |dir: Option<&OwnedFd>, name: &std::ffi::CStr, flags: libc::c_int| {
        // SAFETY: `name` is NUL-terminated; `dir`, when given, is an open
        // folder descriptor; the result is owned below or an error.
        let fd = unsafe {
            match dir {
                Some(dir) => {
                    libc::openat(std::os::fd::AsRawFd::as_raw_fd(dir), name.as_ptr(), flags)
                }
                None => libc::open(name.as_ptr(), flags),
            }
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            return Err(match error.raw_os_error() {
                Some(libc::ELOOP) => Refused::Link,
                Some(libc::ENOTDIR) => Refused::NotAFile,
                _ => Refused::Io(error),
            });
        }
        // SAFETY: a descriptor just returned by open(2), owned from here.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    };
    let folder_flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut dir = open(None, &root_c, folder_flags)?;
    let (last, between) = names.split_last().ok_or(Refused::NotPlain)?;
    for name in between {
        let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| Refused::NotPlain)?;
        dir = open(Some(&dir), &name, folder_flags)?;
    }
    let last = std::ffi::CString::new(last.as_bytes()).map_err(|_| Refused::NotPlain)?;
    // Non-blocking, so a pipe answers at once instead of never.
    let fd = open(
        Some(&dir),
        &last,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
    )?;
    let file = std::fs::File::from(fd);
    let meta = file.metadata().map_err(Refused::Io)?;
    if !meta.file_type().is_file() {
        return Err(Refused::NotAFile);
    }
    Ok(file)
}

#[cfg(not(all(unix, not(any(target_os = "ios", target_os = "android")))))]
fn open_beneath(root: &Path, relative: &Path) -> Result<std::fs::File, Refused> {
    // No jail on this system: the same rules, checked component by
    // component, then opened.
    let names = plain_components(relative)?;
    let mut path = root.to_path_buf();
    for name in names {
        path.push(name);
        let meta = std::fs::symlink_metadata(&path).map_err(Refused::Io)?;
        if meta.file_type().is_symlink() {
            return Err(Refused::Link);
        }
    }
    let meta = std::fs::symlink_metadata(&path).map_err(Refused::Io)?;
    if !meta.is_file() {
        return Err(Refused::NotAFile);
    }
    std::fs::File::open(&path).map_err(Refused::Io)
}

fn read_bounded(file: std::fs::File, limit: u64, prefix: bool) -> Result<(Vec<u8>, bool), Refused> {
    let size = file.metadata().map_err(Refused::Io)?.len();
    if size > limit && !prefix {
        return Err(Refused::TooLarge);
    }
    let mut bytes = Vec::with_capacity(size.min(limit) as usize);
    // One byte past the bound tells a file that grew since from one that
    // did not.
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(Refused::Io)?;
    let more = bytes.len() as u64 > limit;
    if more {
        if !prefix {
            return Err(Refused::TooLarge);
        }
        bytes.truncate(limit as usize);
    }
    Ok((bytes, more))
}

#[cfg(test)]
#[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
mod tests {
    use super::*;

    fn folder() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/a.txt"), "inside").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "OUTSIDE-SECRET").unwrap();
        (dir, root)
    }

    #[test]
    fn a_plain_file_is_read() {
        let (_dir, root) = folder();
        assert_eq!(
            read_beneath(&root, Path::new("sub/a.txt"), 1024).unwrap(),
            b"inside"
        );
    }

    /// A link to a file outside the folder is refused, never read.
    #[test]
    fn a_link_to_a_file_outside_is_refused() {
        let (dir, root) = folder();
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("leak.md")).unwrap();
        assert!(matches!(
            read_beneath(&root, Path::new("leak.md"), 1024),
            Err(Refused::Link)
        ));
    }

    /// A folder on the way replaced by a link is refused.
    #[test]
    fn a_link_in_the_middle_of_the_path_is_refused() {
        let (dir, root) = folder();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("id"), "OUTSIDE-SECRET").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("d")).unwrap();
        let read = read_beneath(&root, Path::new("d/id"), 1024);
        assert!(
            matches!(read, Err(Refused::Link) | Err(Refused::NotAFile)),
            "{read:?}"
        );
    }

    /// A pipe answers at once: refused, never waited on.
    #[test]
    fn a_pipe_is_refused_at_once() {
        let (_dir, root) = folder();
        let fifo = std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(
            root.join("pipe").as_os_str(),
        ))
        .unwrap();
        // SAFETY: a NUL-terminated path in the test's own folder.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();
        assert!(matches!(
            read_beneath(&root, Path::new("pipe"), 1024),
            Err(Refused::NotAFile)
        ));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    /// A file past the bound is refused whole, or cut when a prefix is
    /// asked for.
    #[test]
    fn a_huge_file_is_bounded() {
        let (_dir, root) = folder();
        std::fs::write(root.join("big.bin"), vec![b'x'; 10_000]).unwrap();
        assert!(matches!(
            read_beneath(&root, Path::new("big.bin"), 1_000),
            Err(Refused::TooLarge)
        ));
        let (bytes, more) = read_prefix_beneath(&root, Path::new("big.bin"), 1_000).unwrap();
        assert_eq!(bytes.len(), 1_000);
        assert!(more);
    }

    #[test]
    fn only_plain_relative_paths() {
        let (_dir, root) = folder();
        assert!(matches!(
            read_beneath(&root, Path::new("../secret.txt"), 1024),
            Err(Refused::NotPlain)
        ));
        assert!(matches!(
            read_beneath(&root, Path::new("/etc/passwd"), 1024),
            Err(Refused::NotPlain)
        ));
    }

    /// A resolved path read again from `/`: a link put in since is refused.
    #[test]
    fn a_resolved_path_refuses_a_link_put_in_since() {
        let (dir, root) = folder();
        let resolved = std::fs::canonicalize(root.join("sub/a.txt")).unwrap();
        assert_eq!(read_resolved(&resolved, 1024).unwrap(), b"inside");
        std::fs::remove_file(root.join("sub/a.txt")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("sub/a.txt")).unwrap();
        assert!(matches!(read_resolved(&resolved, 1024), Err(Refused::Link)));
    }
}
