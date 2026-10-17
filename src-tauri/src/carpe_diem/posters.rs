//! Posters for gallery pictures, made here rather than in the webview.
//!
//! A tile paints a filed poster (`subrosa-media:` at `/poster/<name>`) and
//! never the picture itself. The webview used to make the missing ones: load
//! the full picture, draw it on a canvas, encode a JPEG. That is the page's
//! one thread, and every tile near the screen asked at once. A device that
//! had just received a few hundred pictures from another one (posters do not
//! travel, the pictures do) decoded dozens of full-size images together and
//! froze, sometimes until WebKit gave up on the page for its memory.
//!
//! So a picture's poster is made here, off the webview's thread, one picture
//! at a time: right after a synchronized picture lands, and on demand for any
//! tile that still finds none. Clips keep their webview path (no decoder for
//! video ships with the app); they were already decoded one at a time.

use std::path::{Path, PathBuf};

use image::{codecs::jpeg::JpegEncoder, ImageReader};
use serde::Serialize;
use serde_json::json;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;
use tokio::sync::Semaphore;

use super::media::{artifacts_dir, POSTERS_DIR};
use crate::domain::types::AppError;

/// The long edge of a poster: what the webview's canvas path made, so a tile
/// looks the same whichever side filed its poster.
const POSTER_EDGE: u32 = 512;
const POSTER_QUALITY: u8 = 80;

/// One picture decoded at a time, across the sync lane and every tile: a
/// full-size picture is tens of megabytes once decoded, and a phone that
/// decodes ten together is a phone out of memory.
static TURN: Semaphore = Semaphore::const_new(1);

/// What a tile learns from a poster: the picture's own size, not the poster's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosterDto {
    pub poster_version: u32,
    pub width: u32,
    pub height: u32,
}

/// Whether a gallery file is a picture this module can make a poster of.
pub(crate) fn is_picture(file_name: &str) -> bool {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif")
}

fn poster_path(gallery: &Path, name: &str) -> PathBuf {
    gallery.join(POSTERS_DIR).join(format!("{name}.jpg"))
}

fn failed(detail: impl ToString) -> AppError {
    AppError::new("media_poster_failed", detail.to_string())
}

/// Decodes the picture, shrinks it and files the JPEG beside the gallery.
/// Blocking: called on a blocking thread. A poster already on disk is kept,
/// and only the picture's header is read to answer its size.
fn write_poster(gallery: &Path, name: &str) -> Result<PosterDto, AppError> {
    let source = gallery.join(name);
    let target = poster_path(gallery, name);
    let reader = || {
        ImageReader::open(&source)
            .and_then(|reader| reader.with_guessed_format())
            .map_err(failed)
    };
    if target.is_file() {
        let (width, height) = reader()?.into_dimensions().map_err(failed)?;
        return Ok(PosterDto {
            poster_version: 1,
            width,
            height,
        });
    }
    let picture = reader()?.decode().map_err(failed)?;
    let (width, height) = (picture.width(), picture.height());
    let poster = if width.max(height) > POSTER_EDGE {
        picture.thumbnail(POSTER_EDGE, POSTER_EDGE)
    } else {
        picture
    };
    let flattened = crate::hermes_image_fit::flatten_onto_white(&poster);
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, POSTER_QUALITY)
        .encode_image(&flattened)
        .map_err(failed)?;
    let dir = gallery.join(POSTERS_DIR);
    std::fs::create_dir_all(&dir).map_err(failed)?;
    let staging = dir.join(format!("{name}.jpg.part"));
    std::fs::write(&staging, &bytes).map_err(failed)?;
    std::fs::rename(&staging, &target).map_err(failed)?;
    Ok(PosterDto {
        poster_version: 1,
        width,
        height,
    })
}

/// Files a picture's poster and its measures, so its tile paints straight
/// from disk from then on. Waits its turn behind any other picture.
pub(crate) async fn file_poster(
    pool: &SqlitePool,
    gallery: &Path,
    name: &str,
) -> Result<PosterDto, AppError> {
    let name = super::media_protocol::file_name_of(name)
        .filter(|name| is_picture(name))
        .ok_or_else(|| AppError::new("media_artifact_invalid", "That is not a gallery picture."))?;
    let _turn = TURN
        .acquire()
        .await
        .map_err(|_| failed("poster queue closed"))?;
    let gallery = gallery.to_path_buf();
    let file = name.clone();
    let poster = tokio::task::spawn_blocking(move || write_poster(&gallery, &file))
        .await
        .map_err(failed)??;
    crate::studio_project::merge_measures(
        pool,
        &name,
        &json!({
            "posterVersion": poster.poster_version,
            "width": poster.width,
            "height": poster.height,
        }),
    )
    .await
    .map_err(failed)?;
    Ok(poster)
}

/// The poster of a gallery picture that has none yet, made on demand for the
/// tile that asked. The tile then paints it from `subrosa-media:`.
#[tauri::command]
pub async fn carpe_diem_media_make_poster(
    app: AppHandle,
    id: String,
) -> Result<PosterDto, AppError> {
    let gallery = artifacts_dir(&app)?;
    let pool = crate::commands::repositories(&app).await?.pool;
    file_poster(&pool, &gallery, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn picture(dir: &Path, name: &str, width: u32, height: u32) {
        RgbaImage::from_pixel(width, height, Rgba([200, 40, 40, 255]))
            .save(dir.join(name))
            .unwrap();
    }

    #[test]
    fn a_large_picture_gets_a_small_jpeg_and_keeps_its_own_size() {
        let gallery = tempfile::tempdir().unwrap();
        picture(gallery.path(), "a.png", 2048, 1024);
        let poster = write_poster(gallery.path(), "a.png").unwrap();
        assert_eq!(
            poster,
            PosterDto {
                poster_version: 1,
                width: 2048,
                height: 1024
            }
        );
        let filed = image::open(poster_path(gallery.path(), "a.png")).unwrap();
        assert_eq!((filed.width(), filed.height()), (512, 256));
        let bytes = std::fs::read(poster_path(gallery.path(), "a.png")).unwrap();
        assert!(bytes.starts_with(&[0xFF, 0xD8, 0xFF]));
    }

    #[test]
    fn a_filed_poster_is_not_made_again() {
        let gallery = tempfile::tempdir().unwrap();
        picture(gallery.path(), "b.png", 640, 480);
        std::fs::create_dir_all(gallery.path().join(POSTERS_DIR)).unwrap();
        std::fs::write(poster_path(gallery.path(), "b.png"), b"kept").unwrap();
        let poster = write_poster(gallery.path(), "b.png").unwrap();
        assert_eq!((poster.width, poster.height), (640, 480));
        assert_eq!(
            std::fs::read(poster_path(gallery.path(), "b.png")).unwrap(),
            b"kept"
        );
    }

    #[test]
    fn only_pictures_get_posters_here() {
        assert!(is_picture("x.PNG"));
        assert!(is_picture("x.webp"));
        assert!(!is_picture("x.mp4"));
        assert!(!is_picture("x.mp3"));
        assert!(!is_picture("x"));
    }

    #[tokio::test]
    async fn a_name_outside_the_gallery_is_refused() {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let gallery = tempfile::tempdir().unwrap();
        for name in ["../a.png", "a/b.png", ".posters", "clip.mp4"] {
            assert!(file_poster(&pool, gallery.path(), name).await.is_err());
        }
    }
}
