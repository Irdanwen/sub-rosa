//! The DevTools protocol over a pipe (`--remote-debugging-pipe`).
//!
//! The browser reads commands on its fd 3 and writes answers and events on
//! its fd 4, each message one JSON text followed by a NUL byte. Nothing
//! listens on a port, so no other process on the machine can reach the
//! browser the agent drives: the two ends belong to the app alone. The same
//! message cap as the WebSocket holds, for the same reason.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

use super::ws::MAX_MESSAGE_BYTES;

/// Sends one message.
pub async fn send_text<W: AsyncWrite + Unpin + ?Sized>(
    writer: &mut W,
    text: &str,
) -> io::Result<()> {
    if text.as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a DevTools message cannot hold a NUL byte",
        ));
    }
    let mut frame = Vec::with_capacity(text.len() + 1);
    frame.extend_from_slice(text.as_bytes());
    frame.push(0);
    writer.write_all(&frame).await?;
    writer.flush().await
}

/// Reads one message, or `None` once the browser closed its end.
pub async fn read_message<R: AsyncBufRead + Unpin + ?Sized>(
    reader: &mut R,
) -> io::Result<Option<String>> {
    let mut message: Vec<u8> = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if message.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "the browser closed the pipe mid-message",
                ))
            };
        }
        let (chunk, done) = match available.iter().position(|byte| *byte == 0) {
            Some(end) => (&available[..end], Some(end + 1)),
            None => (available, None),
        };
        if message.len() + chunk.len() > MAX_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "a DevTools message was larger than the client accepts",
            ));
        }
        message.extend_from_slice(chunk);
        let consumed = done.unwrap_or(available.len());
        reader.consume(consumed);
        if done.is_some() {
            return String::from_utf8(message).map(Some).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "a message was not UTF-8")
            });
        }
    }
}

/// One pipe, both ends close-on-exec: neither the browser nor any other
/// child the app starts inherits them by accident. The browser gets its two
/// ends through [`ChildEnds`], placed on fds 3 and 4.
#[cfg(unix)]
pub fn pair() -> io::Result<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)> {
    use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: `fds` has room for the two descriptors `pipe` writes.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `pipe` succeeded, so both are fresh descriptors nothing else owns.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    for fd in [&read, &write] {
        // SAFETY: `fd` is open and owned above.
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok((read, write))
}

/// The browser's two ends, as raw numbers for the hook that runs in the
/// child between fork and exec.
#[cfg(unix)]
#[derive(Clone, Copy)]
pub struct ChildEnds {
    reads: libc::c_int,
    writes: libc::c_int,
}

#[cfg(unix)]
impl ChildEnds {
    pub fn new(reads: &std::os::fd::OwnedFd, writes: &std::os::fd::OwnedFd) -> Self {
        use std::os::fd::AsRawFd as _;
        Self {
            reads: reads.as_raw_fd(),
            writes: writes.as_raw_fd(),
        }
    }

    /// Places the ends on fds 3 (commands in) and 4 (answers out). Each end
    /// is first copied above both targets, so placing one can never
    /// overwrite the other; `dup2` leaves the copies on 3 and 4 open across
    /// exec while the originals, close-on-exec, go.
    pub fn install(self) -> io::Result<()> {
        // SAFETY: called between fork and exec; `fcntl`, `dup2` and `close`
        // are async-signal-safe and touch only descriptors of this child.
        unsafe {
            let reads = libc::fcntl(self.reads, libc::F_DUPFD, 10);
            let writes = libc::fcntl(self.writes, libc::F_DUPFD, 10);
            if reads < 0 || writes < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::dup2(reads, 3) < 0 || libc::dup2(writes, 4) < 0 {
                return Err(io::Error::last_os_error());
            }
            libc::close(reads);
            libc::close(writes);
        }
        Ok(())
    }
}
