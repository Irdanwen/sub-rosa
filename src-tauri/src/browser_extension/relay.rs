//! The app binary as a native messaging host (ADR-0100).
//!
//! The browser starts the host itself, as a fresh process, and talks to it
//! over stdin and stdout. That process is not the app the person is using:
//! it has no window, no database pool, no sidecar. So it does one thing:
//! connect to the running app's socket (`endpoint`), tell it which
//! extension launched it, and copy bytes both ways until either side
//! closes. It never parses a message; the app does.
//!
//! `main` checks [`invoked_as_host`] before anything else, so Tauri, the
//! single-instance plugin and the updater never start in this mode.

use std::ffi::OsString;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::host_manifest::GECKO_EXTENSION_ID;
use super::protocol::{write_frame, Response};

/// Who launched us, when the arguments are the ones a browser passes to a
/// native messaging host: Chromium passes the caller's origin
/// (`chrome-extension://<id>/`, and on Windows a `--parent-window=` after
/// it); Firefox passes the manifest's path and the add-on id.
pub fn invoked_as_host<I: IntoIterator<Item = OsString>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find_map(|arg| {
        let arg = arg.to_string_lossy();
        if arg.starts_with("chrome-extension://") {
            Some(arg.into_owned())
        } else if arg == GECKO_EXTENSION_ID {
            Some(format!("moz-extension:{GECKO_EXTENSION_ID}"))
        } else {
            None
        }
    })
}

/// Runs the relay to completion. The process exits with the code returned.
pub fn run(origin: String) -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return 1,
    };
    let code = runtime.block_on(relay(origin));
    // Stdin's reader is a blocking thread the runtime would wait on forever.
    runtime.shutdown_background();
    code
}

async fn relay(origin: String) -> i32 {
    let mut stdout = tokio::io::stdout();
    let Some((app_read, mut app_write)) = connect().await else {
        let refusal = Response::error(
            None,
            "app_not_running",
            "Sub Rosa is not open. Open it, then try again.",
        );
        let _ = write_frame(&mut stdout, &refusal.to_bytes()).await;
        return 0;
    };
    let hello = serde_json::json!({ "type": "origin", "origin": origin });
    if write_frame(&mut app_write, hello.to_string().as_bytes())
        .await
        .is_err()
    {
        return 1;
    }
    let stdin = tokio::io::stdin();
    tokio::select! {
        _ = pump(stdin, app_write) => {}
        _ = pump(app_read, stdout) => {}
    }
    0
}

/// Copies until the reader ends, flushing every chunk: a browser reads a
/// message only once all of it has arrived, and stdout buffers.
pub async fn pump<R, W>(mut reader: R, mut writer: W) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            let _ = writer.shutdown().await;
            return Ok(());
        }
        writer.write_all(&buffer[..read]).await?;
        writer.flush().await?;
    }
}

type Halves = (
    Box<dyn AsyncRead + Unpin + Send>,
    Box<dyn AsyncWrite + Unpin + Send>,
);

#[cfg(unix)]
async fn connect() -> Option<Halves> {
    let path = super::endpoint::socket_path()?;
    let stream = tokio::net::UnixStream::connect(path).await.ok()?;
    let (read, write) = stream.into_split();
    Some((Box::new(read), Box::new(write)))
}

#[cfg(windows)]
async fn connect() -> Option<Halves> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231;
    let name = super::endpoint::pipe_name()?;
    for _ in 0..20 {
        match ClientOptions::new().open(&name) {
            Ok(client) => {
                let (read, write) = tokio::io::split(client);
                return Some((Box::new(read), Box::new(write)));
            }
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(_) => return None,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn a_chromium_launch_is_recognised_by_its_origin() {
        assert_eq!(
            invoked_as_host(args(&["os-june", "chrome-extension://abc/"])).as_deref(),
            Some("chrome-extension://abc/")
        );
        assert_eq!(
            invoked_as_host(args(&[
                "os-june.exe",
                "chrome-extension://abc/",
                "--parent-window=0"
            ]))
            .as_deref(),
            Some("chrome-extension://abc/")
        );
    }

    #[test]
    fn a_firefox_launch_is_recognised_by_the_add_on_id() {
        assert_eq!(
            invoked_as_host(args(&[
                "os-june",
                "/Users/ana/Library/Application Support/Mozilla/NativeMessagingHosts/xyz.carpediem.subrosa.json",
                GECKO_EXTENSION_ID
            ]))
            .as_deref(),
            Some("moz-extension:browser-extension@subrosa.carpediem.xyz")
        );
    }

    #[test]
    fn an_ordinary_launch_or_a_deep_link_is_not_a_host() {
        assert_eq!(invoked_as_host(args(&["os-june"])), None);
        assert_eq!(
            invoked_as_host(args(&["os-june", "subrosa://chat/new"])),
            None
        );
        // The program name itself is never read as an argument.
        assert_eq!(invoked_as_host(args(&["chrome-extension://abc/"])), None);
    }

    #[tokio::test]
    async fn the_pump_copies_until_the_reader_ends() {
        let (mut browser, relay_in) = tokio::io::duplex(16);
        let (relay_out, mut app) = tokio::io::duplex(1024);
        let task = tokio::spawn(pump(relay_in, relay_out));
        let body = vec![7u8; 100];
        browser.write_all(&body).await.unwrap();
        drop(browser);
        task.await.unwrap().unwrap();
        let mut received = Vec::new();
        app.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, body);
    }
}
