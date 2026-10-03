//! `subrosa-media:` — the Studio gallery, streamed to the webview from disk.
//!
//! Before this, a phone played a clip by reading the whole file over IPC as
//! base64, rebuilding it in JavaScript and handing the `<video>` a `blob:` URL.
//! That cost roughly five times the file in memory at the peak, and the blob
//! lived in a small evicting cache: a gallery that kept loading tiles behind
//! the viewer revoked the URL that was playing, and the clip stopped after the
//! few seconds already buffered. A media element wants byte ranges from a
//! file, so this answers byte ranges from the file.
//!
//! The URL names a gallery file by its name, never by a path: `/<file name>`.
//! Anything that is not a bare file name of the gallery is refused, so the
//! scheme cannot reach outside `$APPDATA/studio-media/` whatever the webview
//! asks. That is also why it does not reuse the asset protocol, whose scope is
//! matched against absolute paths that move under an iOS container.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Runtime, UriSchemeContext, UriSchemeResponder};

/// The scheme name the webview addresses (`subrosa-media://localhost/<name>`,
/// or `http://subrosa-media.localhost/<name>` where the platform needs it).
pub const SCHEME: &str = "subrosa-media";

/// The most one response carries. A media element asks for open ranges
/// (`bytes=0-`) and keeps asking where the last answer stopped, so a bounded
/// answer streams a three-hundred-megabyte clip in steady steps instead of
/// reading it whole. The same bound the asset protocol uses.
const MAX_RANGE_BYTES: u64 = 1024 * 1024;

/// What a request resolved to before any file was opened.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ByteRange {
    Whole,
    /// Inclusive bounds, already clamped to the file and to [`MAX_RANGE_BYTES`].
    Part {
        start: u64,
        end: u64,
    },
    Unsatisfiable,
}

/// Registers the scheme on a builder. Reading happens off the webview's
/// thread: a scheme handler that blocks stalls every other request the page
/// makes while a clip loads.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(
        SCHEME,
        |ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(respond(&app, &request));
            });
        },
    )
}

fn respond<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(name) = file_name_of(request.uri().path()) else {
        return status(StatusCode::FORBIDDEN);
    };
    let Ok(dir) = gallery_dir(app) else {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    match serve(&dir.join(&name), range) {
        Ok(response) => response,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => status(StatusCode::NOT_FOUND),
        Err(error) => {
            tracing::warn!("subrosa-media: could not read a gallery file: {error}");
            status(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

fn gallery_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, ()> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(super::media::ARTIFACTS_DIR))
        .map_err(|_| ())
}

/// The one file name a request path may name, or nothing.
///
/// Percent-decoded first, so `%2e%2e` is judged as the `..` it spells. A name
/// is a single component with no separator, not hidden, and not a parent
/// reference: exactly the shape the gallery writes (`<uuid>.<ext>`).
pub(crate) fn file_name_of(path: &str) -> Option<String> {
    let raw = path.strip_prefix('/').unwrap_or(path);
    let decoded = percent_decode(raw)?;
    let valid = !decoded.is_empty()
        && decoded.len() <= 255
        && !decoded.starts_with('.')
        && !decoded.contains(['/', '\\', '\0', ':']);
    valid.then_some(decoded)
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = raw.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Parses a `Range` header against a file length. Only the single-range forms
/// a media element sends are honoured (`a-b`, `a-`, `-n`); anything else is
/// served whole, which is always a correct answer to a range request.
pub(crate) fn byte_range(header: Option<&str>, len: u64) -> ByteRange {
    let Some(spec) = header.and_then(|value| value.trim().strip_prefix("bytes=")) else {
        return ByteRange::Whole;
    };
    if spec.contains(',') {
        return ByteRange::Whole;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return ByteRange::Whole;
    };
    let (first, last) = (first.trim(), last.trim());
    let (start, end) = match (first.is_empty(), last.is_empty()) {
        (false, _) => {
            let Ok(start) = first.parse::<u64>() else {
                return ByteRange::Whole;
            };
            let end = if last.is_empty() {
                len.saturating_sub(1)
            } else {
                match last.parse::<u64>() {
                    Ok(end) => end.min(len.saturating_sub(1)),
                    Err(_) => return ByteRange::Whole,
                }
            };
            (start, end)
        }
        (true, false) => {
            let Ok(suffix) = last.parse::<u64>() else {
                return ByteRange::Whole;
            };
            if suffix == 0 {
                return ByteRange::Unsatisfiable;
            }
            (len.saturating_sub(suffix), len.saturating_sub(1))
        }
        (true, true) => return ByteRange::Whole,
    };
    if len == 0 || start >= len || end < start {
        return ByteRange::Unsatisfiable;
    }
    ByteRange::Part {
        start,
        end: end.min(start + MAX_RANGE_BYTES - 1),
    }
}

fn serve(path: &Path, range: Option<&str>) -> std::io::Result<Response<Vec<u8>>> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let mime = mime_for(path);
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-cache");
    let response = match byte_range(range, len) {
        ByteRange::Whole => {
            let mut body = Vec::with_capacity(len as usize);
            file.read_to_end(&mut body)?;
            builder
                .status(StatusCode::OK)
                .header(header::CONTENT_LENGTH, body.len())
                .body(body)
        }
        ByteRange::Part { start, end } => {
            let wanted = end + 1 - start;
            let mut body = Vec::with_capacity(wanted as usize);
            file.seek(SeekFrom::Start(start))?;
            file.take(wanted).read_to_end(&mut body)?;
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, body.len())
                .body(body)
        }
        ByteRange::Unsatisfiable => builder
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new()),
    };
    response.map_err(std::io::Error::other)
}

fn mime_for(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .body(Vec::new())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_names_one_gallery_file_and_nothing_else() {
        assert_eq!(file_name_of("/abc.mp4").as_deref(), Some("abc.mp4"));
        assert_eq!(file_name_of("/a%20b.png").as_deref(), Some("a b.png"));
        for refused in [
            "/",
            "/../secret",
            "/%2e%2e%2fsecret",
            "/sub/abc.mp4",
            "/sub%2Fabc.mp4",
            "/.posters",
            "/..",
            "/a\\b.png",
            "/C:%5Cwin.ini",
            "/%zz",
            "/%00.png",
        ] {
            assert_eq!(file_name_of(refused), None, "{refused} must be refused");
        }
    }

    #[test]
    fn ranges_are_clamped_to_the_file_and_to_one_step() {
        assert_eq!(byte_range(None, 100), ByteRange::Whole);
        assert_eq!(
            byte_range(Some("bytes=0-1"), 100),
            ByteRange::Part { start: 0, end: 1 }
        );
        assert_eq!(
            byte_range(Some("bytes=10-"), 100),
            ByteRange::Part { start: 10, end: 99 }
        );
        assert_eq!(
            byte_range(Some("bytes=-10"), 100),
            ByteRange::Part { start: 90, end: 99 }
        );
        assert_eq!(
            byte_range(Some("bytes=50-500"), 100),
            ByteRange::Part { start: 50, end: 99 }
        );
        let big = 50 * MAX_RANGE_BYTES;
        assert_eq!(
            byte_range(Some("bytes=0-"), big),
            ByteRange::Part {
                start: 0,
                end: MAX_RANGE_BYTES - 1
            }
        );
    }

    #[test]
    fn impossible_ranges_say_so_and_odd_ones_get_the_whole_file() {
        assert_eq!(
            byte_range(Some("bytes=100-"), 100),
            ByteRange::Unsatisfiable
        );
        assert_eq!(byte_range(Some("bytes=9-3"), 100), ByteRange::Unsatisfiable);
        assert_eq!(byte_range(Some("bytes=-0"), 100), ByteRange::Unsatisfiable);
        assert_eq!(byte_range(Some("bytes=0-1,5-6"), 100), ByteRange::Whole);
        assert_eq!(byte_range(Some("items=0-1"), 100), ByteRange::Whole);
        assert_eq!(byte_range(Some("bytes=x-"), 100), ByteRange::Whole);
    }

    #[test]
    fn a_partial_answer_carries_exactly_its_bytes() {
        let dir = std::env::temp_dir().join(format!("subrosa-media-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clip.mp4");
        std::fs::write(&path, (0u8..=99).collect::<Vec<_>>()).unwrap();
        let response = serve(&path, Some("bytes=10-19")).unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), &(10u8..=19).collect::<Vec<_>>());
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 10-19/100");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
        let whole = serve(&path, None).unwrap();
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.body().len(), 100);
        std::fs::remove_dir_all(&dir).ok();
    }
}
