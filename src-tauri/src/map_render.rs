//! Static map composition for the places chat block (ADR-0024).
//!
//! The webview CSP blocks third-party fetches, iframes, and scripts, so the
//! map is not a JS library: Rust downloads OSM raster tiles, stitches them,
//! and hands the webview one `data:` PNG. Pins are NOT baked in — the card
//! overlays them in DOM from the same Web-Mercator math (map-projection.ts),
//! which is what makes them hoverable and keeps this module dumb.
//!
//! Tile policy (https://operations.osmfoundation.org/policies/tiles/): an
//! identifying User-Agent and no heavy traffic. Tiles are cached on disk for
//! thirty days, a card is at most ~24 tiles, and requests run 4-wide.

use crate::domain::types::AppError;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const TILE_SIZE: u32 = 256;
const TILE_BASE_URL: &str = "https://tile.openstreetmap.org";
const USER_AGENT: &str = "SubRosa/1.0 (+https://github.com/Irdanwen/sub-rosa)";
const CACHE_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_DIMENSION: u32 = 1200;
const MAX_TILES: usize = 32;
const MAX_ZOOM: u8 = 19;
const FETCH_CONCURRENCY: usize = 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderMapCardRequest {
    pub center_lat: f64,
    pub center_lng: f64,
    pub zoom: u8,
    /// Logical (CSS) pixels; the image is rendered at 2x for retina.
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderMapCardResponse {
    pub data_url: String,
}

/// Web-Mercator world-pixel projection at `zoom` (tile grid of 256px tiles).
fn project(lat: f64, lng: f64, zoom: u8) -> (f64, f64) {
    let world = f64::from(TILE_SIZE) * 2f64.powi(i32::from(zoom));
    let x = (lng + 180.0) / 360.0 * world;
    let lat_rad = lat.to_radians();
    let y = (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0 * world;
    (x, y)
}

fn tile_cache_path(app: &AppHandle, zoom: u8, x: u32, y: u32) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(
        dir.join("map-tiles")
            .join(zoom.to_string())
            .join(x.to_string())
            .join(format!("{y}.png")),
    )
}

async fn cached_tile(path: &PathBuf) -> Option<Vec<u8>> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    let age = metadata.modified().ok()?.elapsed().ok()?;
    if age > CACHE_TTL {
        return None;
    }
    tokio::fs::read(path).await.ok()
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        crate::http_client::anonymous(Duration::from_secs(8))
            .user_agent(USER_AGENT)
            .build()
            .unwrap_or_default()
    })
}

async fn fetch_tile(app: &AppHandle, zoom: u8, x: u32, y: u32) -> Result<Vec<u8>, AppError> {
    let cache_path = tile_cache_path(app, zoom, x, y);
    if let Some(path) = &cache_path {
        if let Some(bytes) = cached_tile(path).await {
            return Ok(bytes);
        }
    }
    let url = format!("{TILE_BASE_URL}/{zoom}/{x}/{y}.png");
    let response = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|error| AppError::new("map_tile_failed", error.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "map_tile_failed",
            format!("tile {zoom}/{x}/{y} answered {}", response.status()),
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::new("map_tile_failed", error.to_string()))?
        .to_vec();
    if let Some(path) = cache_path {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&path, &bytes).await;
    }
    Ok(bytes)
}

/// The tile grid a viewport needs: inclusive ranges plus the canvas offset of
/// the first tile. Pure, so the geometry is testable without HTTP.
fn tile_plan(
    center_lat: f64,
    center_lng: f64,
    zoom: u8,
    width: u32,
    height: u32,
) -> (
    std::ops::RangeInclusive<i64>,
    std::ops::RangeInclusive<i64>,
    f64,
    f64,
) {
    let (cx, cy) = project(center_lat, center_lng, zoom);
    let left = cx - f64::from(width) / 2.0;
    let top = cy - f64::from(height) / 2.0;
    let tile = f64::from(TILE_SIZE);
    let first_x = (left / tile).floor() as i64;
    let first_y = (top / tile).floor() as i64;
    let last_x = ((left + f64::from(width)) / tile).ceil() as i64 - 1;
    let last_y = ((top + f64::from(height)) / tile).ceil() as i64 - 1;
    (first_x..=last_x, first_y..=last_y, left, top)
}

#[tauri::command]
pub async fn render_map_card(
    app: AppHandle,
    request: RenderMapCardRequest,
) -> Result<RenderMapCardResponse, AppError> {
    if !(-85.0..=85.0).contains(&request.center_lat)
        || !(-180.0..=180.0).contains(&request.center_lng)
    {
        return Err(AppError::new(
            "map_render_rejected",
            "Center is out of range.",
        ));
    }
    // Retina: double the canvas and use the next zoom level, so the image is
    // crisp at the card's CSS size while the pin math stays at `zoom`.
    let zoom = request.zoom.min(MAX_ZOOM - 1) + 1;
    let width = (request.width.clamp(64, MAX_DIMENSION)) * 2;
    let height = (request.height.clamp(64, MAX_DIMENSION)) * 2;

    let (xs, ys, left, top) =
        tile_plan(request.center_lat, request.center_lng, zoom, width, height);
    let world_tiles = 1i64 << i64::from(zoom);
    let mut wanted: Vec<(i64, i64)> = Vec::new();
    for ty in ys.clone() {
        for tx in xs.clone() {
            if (0..world_tiles).contains(&ty) {
                wanted.push((tx.rem_euclid(world_tiles), ty));
            }
        }
    }
    if wanted.is_empty() || wanted.len() > MAX_TILES {
        return Err(AppError::new(
            "map_render_rejected",
            "Viewport is out of range.",
        ));
    }

    // 4-wide fetch, preserving (tx, ty) association.
    let mut tiles: Vec<((i64, i64), Vec<u8>)> = Vec::with_capacity(wanted.len());
    for chunk in wanted.chunks(FETCH_CONCURRENCY) {
        let mut set = tokio::task::JoinSet::new();
        for &(tx, ty) in chunk {
            let app = app.clone();
            set.spawn(async move {
                let bytes = fetch_tile(&app, zoom, tx as u32, ty as u32).await?;
                Ok::<((i64, i64), Vec<u8>), AppError>(((tx, ty), bytes))
            });
        }
        while let Some(joined) = set.join_next().await {
            let result =
                joined.map_err(|error| AppError::new("map_render_failed", error.to_string()))?;
            tiles.push(result?);
        }
    }

    let mut canvas = image::RgbaImage::from_pixel(width, height, image::Rgba([234, 231, 223, 255]));
    for ((tx, ty), bytes) in tiles {
        let Ok(tile_image) = image::load_from_memory(&bytes) else {
            continue;
        };
        let tile_rgba = tile_image.to_rgba8();
        // The unwrapped x position (before rem_euclid) is what lines up on
        // the canvas; recompute it from the visible range.
        for candidate_x in xs.clone() {
            if candidate_x.rem_euclid(world_tiles) != tx {
                continue;
            }
            let offset_x = (candidate_x as f64) * f64::from(TILE_SIZE) - left;
            let offset_y = (ty as f64) * f64::from(TILE_SIZE) - top;
            image::imageops::overlay(&mut canvas, &tile_rgba, offset_x as i64, offset_y as i64);
        }
    }

    let mut png = Vec::new();
    canvas
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|error| AppError::new("map_render_failed", error.to_string()))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    Ok(RenderMapCardResponse {
        data_url: format!("data:image/png;base64,{encoded}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_matches_known_anchors() {
        // Lat 0 / lng 0 sits at the exact center of the world grid.
        let (x, y) = project(0.0, 0.0, 1);
        assert!((x - 256.0).abs() < 1e-6);
        assert!((y - 256.0).abs() < 1e-6);
        // Positive longitudes move east, positive latitudes move up (smaller y).
        let (east, north_y) = project(45.0, 90.0, 1);
        assert!(east > 256.0);
        assert!(north_y < 256.0);
    }

    #[test]
    fn tile_plan_covers_the_viewport() {
        let (xs, ys, left, top) = tile_plan(46.194, 6.235, 14, 1120, 440);
        let tile_count = (xs.end() - xs.start() + 1) * (ys.end() - ys.start() + 1);
        assert!(tile_count > 0 && tile_count <= MAX_TILES as i64);
        // The first tile's canvas offset must be at or left/above the origin.
        assert!((*xs.start() as f64) * 256.0 - left <= 0.0);
        assert!((*ys.start() as f64) * 256.0 - top <= 0.0);
    }
}
