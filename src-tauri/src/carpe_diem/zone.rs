//! A zone retouch is sent as a crop and comes back as a crop. This puts it
//! back: the result is resampled to the rectangle it came from and blended into
//! the parent through a feathered mask the webview drew at that size. Every
//! pixel outside the mask is the parent's own, at the parent's resolution.
//!
//! It runs here, in the job's delivery, rather than in the webview: the result
//! can land while the webview is frozen (ADR-0018), a large parent would exceed
//! the canvas limits of the iOS webview, and the version that reaches the
//! gallery is the merged one, never a loose crop.

use image::{imageops::FilterType, ImageFormat, RgbaImage};
use serde::Deserialize;
use std::io::Cursor;

/// Upper bound on the mask a job may carry: a crop-sized grayscale PNG.
pub const MAX_MASK_BASE64: usize = 4 * 1024 * 1024;

/// What the webview sends with a zone retouch.
#[derive(Clone, Debug, Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompositeSpec {
    /// The gallery file the crop was cut from. A name, never a path: the iOS
    /// data container moves across reinstalls.
    pub parent_file_name: String,
    /// The rectangle that was sent, in the parent's pixels: x, y, width, height.
    pub crop: [u32; 4],
    /// Grayscale PNG at the crop's size, white where the result shows.
    pub mask_png_base64: String,
}

impl CompositeSpec {
    /// Shape checks that do not need the files.
    pub fn validate(&self) -> Result<(), &'static str> {
        let name = self.parent_file_name.as_str();
        if name.is_empty()
            || name.len() > 128
            || name.contains(['/', '\\'])
            || name.starts_with('.')
        {
            return Err("The zone's source image is invalid.");
        }
        let [_, _, width, height] = self.crop;
        if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
            return Err("The zone is invalid.");
        }
        if self.mask_png_base64.is_empty() || self.mask_png_base64.len() > MAX_MASK_BASE64 {
            return Err("The zone's mask is invalid.");
        }
        Ok(())
    }
}

/// Blend `result` into `parent` inside `crop`, through `mask`. Returns PNG
/// bytes at the parent's size.
pub fn composite(
    parent: &[u8],
    result: &[u8],
    crop: [u32; 4],
    mask_png: &[u8],
) -> Result<Vec<u8>, String> {
    let mut base = image::load_from_memory(parent)
        .map_err(|error| format!("parent: {error}"))?
        .to_rgba8();
    let [x, y, width, height] = crop;
    let fits = |start: u32, length: u32, limit: u32| {
        start.checked_add(length).is_some_and(|end| end <= limit)
    };
    if !fits(x, width, base.width()) || !fits(y, height, base.height()) {
        return Err("crop outside the parent".into());
    }
    let edited = image::load_from_memory(result)
        .map_err(|error| format!("result: {error}"))?
        .to_rgba8();
    let edited = if edited.dimensions() == (width, height) {
        edited
    } else {
        image::imageops::resize(&edited, width, height, FilterType::Lanczos3)
    };
    let mask = image::load_from_memory(mask_png)
        .map_err(|error| format!("mask: {error}"))?
        .to_luma8();
    let mask = if mask.dimensions() == (width, height) {
        mask
    } else {
        image::imageops::resize(&mask, width, height, FilterType::Triangle)
    };
    blend(&mut base, &edited, &mask, x, y);
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(base)
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|error| format!("encode: {error}"))?;
    Ok(out.into_inner())
}

fn blend(base: &mut RgbaImage, edited: &RgbaImage, mask: &image::GrayImage, x: u32, y: u32) {
    for (dx, dy, pixel) in edited.enumerate_pixels() {
        let alpha = u32::from(mask.get_pixel(dx, dy)[0]);
        if alpha == 0 {
            continue;
        }
        let target = base.get_pixel_mut(x + dx, y + dy);
        for channel in 0..3 {
            let under = u32::from(target[channel]);
            let over = u32::from(pixel[channel]);
            target[channel] = ((over * alpha + under * (255 - alpha) + 127) / 255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GrayImage, Luma, Rgba};

    fn png(image: image::DynamicImage) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn solid(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        png(image::DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            width,
            height,
            Rgba(color),
        )))
    }

    #[test]
    fn leaves_every_pixel_outside_the_mask_untouched() {
        let parent = solid(40, 30, [10, 20, 30, 255]);
        // The model answers at its own size: twice the crop here.
        let result = solid(20, 20, [200, 100, 50, 255]);
        let mut mask = GrayImage::new(10, 10);
        for y in 2..8 {
            for x in 2..8 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        let mask = png(image::DynamicImage::ImageLuma8(mask));
        let merged = composite(&parent, &result, [5, 6, 10, 10], &mask).unwrap();
        let merged = image::load_from_memory(&merged).unwrap().to_rgba8();
        assert_eq!(merged.dimensions(), (40, 30));
        for (x, y, pixel) in merged.enumerate_pixels() {
            let inside = (7..13).contains(&x) && (8..14).contains(&y);
            let expected = if inside {
                [200, 100, 50, 255]
            } else {
                [10, 20, 30, 255]
            };
            assert_eq!(pixel.0, expected, "pixel {x},{y}");
        }
    }

    #[test]
    fn feathers_through_a_partial_mask() {
        let parent = solid(4, 4, [0, 0, 0, 255]);
        let result = solid(4, 4, [255, 255, 255, 255]);
        let mask = png(image::DynamicImage::ImageLuma8(GrayImage::from_pixel(
            4,
            4,
            Luma([128]),
        )));
        let merged = composite(&parent, &result, [0, 0, 4, 4], &mask).unwrap();
        let merged = image::load_from_memory(&merged).unwrap().to_rgba8();
        assert_eq!(merged.get_pixel(1, 1).0, [128, 128, 128, 255]);
    }

    #[test]
    fn refuses_a_crop_outside_the_parent() {
        let parent = solid(10, 10, [0, 0, 0, 255]);
        let result = solid(4, 4, [255, 255, 255, 255]);
        let mask = png(image::DynamicImage::ImageLuma8(GrayImage::new(4, 4)));
        assert!(composite(&parent, &result, [8, 8, 4, 4], &mask).is_err());
        assert!(composite(&parent, &result, [u32::MAX, 0, 4, 4], &mask).is_err());
    }

    #[test]
    fn validates_the_spec_before_touching_files() {
        let spec = |name: &str, crop: [u32; 4], mask: &str| CompositeSpec {
            parent_file_name: name.into(),
            crop,
            mask_png_base64: mask.into(),
        };
        assert!(spec("a.png", [0, 0, 4, 4], "AAAA").validate().is_ok());
        assert!(spec("../a.png", [0, 0, 4, 4], "AAAA").validate().is_err());
        assert!(spec(".hidden", [0, 0, 4, 4], "AAAA").validate().is_err());
        assert!(spec("a.png", [0, 0, 0, 4], "AAAA").validate().is_err());
        assert!(spec("a.png", [0, 0, 4, 4], "").validate().is_err());
    }
}
