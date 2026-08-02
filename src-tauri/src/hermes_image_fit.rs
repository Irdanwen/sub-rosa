//! Fitting an attached image to what the request can actually carry.
//!
//! An image costs a vision model on the order of a thousand tokens no matter
//! how many bytes it arrives in — the model downsamples it to its own grid
//! before looking at it. The transport does not know that. Every size gate
//! between the composer and the provider counts an image's base64 against a
//! budget that was sized for prose:
//!
//! - the loopback proxy's chat body cap (`JUNE_PROVIDER_PROXY_MAX_BODY_BYTES`,
//!   3 MiB), and
//! - june-api's per-string and aggregate character caps
//!   (`MAX_AGENT_STRING_CHARS` / `MAX_AGENT_TOTAL_STRING_CHARS`, 1.5M chars
//!   each), which exist to bound a *pasted document* against the model window.
//!
//! Base64 inflates 4/3, so an ordinary 2.4 MB screenshot arrives as ~3.2 MB —
//! over all three at once. The user saw this as "the model can't read images":
//! the attach succeeded, the request was rejected for length, and the agent
//! spent the turn compressing a history that was never the problem. Raising
//! the caps would only move the wall (the provider has its own), and it would
//! spend the text budget on bytes the model discards anyway.
//!
//! So the bytes are cut here instead, at the one place that knows the payload
//! is an image: re-encode to fit a budget, keeping the picture the model needs
//! and dropping only the resolution and precision it was going to throw away.
//!
//! Two deliberate choices:
//!
//! - **An image already within budget is passed through untouched.** Text in a
//!   screenshot survives lossless PNG better than any JPEG, and most pastes are
//!   already small. Re-encoding is what we do when we must, not by default.
//! - **JPEG on the way down, composited onto white.** JPEG has no alpha, and
//!   dropping the channel outright turns a transparent screenshot black — the
//!   one background that hides dark UI text.

use image::{
    codecs::jpeg::JpegEncoder, DynamicImage, ExtendedColorType, ImageReader, Rgb, RgbImage,
};
use std::io::Cursor;

/// Long edge past which pixels stop buying the model anything. Vision stacks
/// downsample to roughly this before inference, so a larger source only costs
/// transport. Applied when an image needs fitting, never to a passthrough.
const MODEL_IMAGE_MAX_EDGE: u32 = 1568;

/// A within-budget image is only passed through untouched below this edge.
/// Above it we re-encode even when the bytes fit, because some providers reject
/// outsized dimensions outright rather than downsampling them.
const PASSTHROUGH_MAX_EDGE: u32 = 2048;

/// Tried in order until the encode fits the budget. Quality first (cheap,
/// invisible to a model at 85), then resolution.
const JPEG_QUALITY_LADDER: [u8; 4] = [85, 72, 60, 45];
const EDGE_LADDER: [u32; 3] = [MODEL_IMAGE_MAX_EDGE, 1024, 768];

/// An image ready to hand to the gateway: the bytes and the mime that now
/// describes them (re-encoding changes it to `image/jpeg`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FittedImage {
    pub mime_type: &'static str,
    pub bytes: Vec<u8>,
}

impl FittedImage {
    /// Base64 length these bytes will occupy — what the character caps
    /// downstream actually count.
    pub fn encoded_len(&self) -> usize {
        self.bytes.len().div_ceil(3) * 4
    }
}

/// Fit `bytes` into `budget` bytes, re-encoding only if it must.
///
/// Never fails: an image it cannot decode (an exotic or corrupt file) comes
/// back untouched, so this can only improve a request, never block one. If even
/// the smallest rung of the ladder overshoots, the smallest result is returned
/// anyway — the caller's existing error path still reports an over-cap request
/// honestly rather than silently sending nothing.
pub fn fit_image_for_model(bytes: Vec<u8>, mime_type: &'static str, budget: usize) -> FittedImage {
    if fits_untouched(&bytes, budget) {
        return FittedImage { mime_type, bytes };
    }
    let Some(decoded) = decode(&bytes) else {
        return FittedImage { mime_type, bytes };
    };

    let mut smallest: Option<Vec<u8>> = None;
    for edge in EDGE_LADDER {
        let resized = fit_within_edge(&decoded, edge);
        let flattened = flatten_onto_white(&resized);
        for quality in JPEG_QUALITY_LADDER {
            let Some(encoded) = encode_jpeg(&flattened, quality) else {
                continue;
            };
            if encoded.len() <= budget {
                return FittedImage {
                    mime_type: "image/jpeg",
                    bytes: encoded,
                };
            }
            let improves = match smallest.as_ref() {
                Some(best) => encoded.len() < best.len(),
                None => true,
            };
            if improves {
                smallest = Some(encoded);
            }
        }
    }

    match smallest {
        // Still over budget, but far closer than the original: send the best we
        // managed rather than the untouched file.
        Some(encoded) if encoded.len() < bytes.len() => FittedImage {
            mime_type: "image/jpeg",
            bytes: encoded,
        },
        _ => FittedImage { mime_type, bytes },
    }
}

/// Whether the file can go as-is: within budget and not outsized. Reads only
/// the header for dimensions, so a passthrough never pays for a full decode.
fn fits_untouched(bytes: &[u8], budget: usize) -> bool {
    if bytes.len() > budget {
        return false;
    }
    match dimensions(bytes) {
        Some((width, height)) => width.max(height) <= PASSTHROUGH_MAX_EDGE,
        // Unknown dimensions and within budget: nothing to gain by re-encoding.
        None => true,
    }
}

fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

fn decode(bytes: &[u8]) -> Option<DynamicImage> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()
}

/// Scale down so the long edge is at most `edge`, preserving aspect ratio.
/// Never scales up — a small image stays its own size.
fn fit_within_edge(image: &DynamicImage, edge: u32) -> DynamicImage {
    if image.width().max(image.height()) <= edge {
        return image.clone();
    }
    image.resize(edge, edge, image::imageops::FilterType::Lanczos3)
}

/// Composite onto white so transparency survives the trip to JPEG. Dropping the
/// alpha channel instead would render a transparent background black and hide
/// exactly the dark text a screenshot was attached for.
fn flatten_onto_white(image: &DynamicImage) -> RgbImage {
    let rgba = image.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let [red, green, blue, alpha] = pixel.0;
        let alpha = u32::from(alpha);
        let over = |channel: u8| -> u8 {
            ((u32::from(channel) * alpha + 255 * (255 - alpha)) / 255).min(255) as u8
        };
        out.put_pixel(x, y, Rgb([over(red), over(green), over(blue)]));
    }
    out
}

fn encode_jpeg(image: &RgbImage, quality: u8) -> Option<Vec<u8>> {
    let mut buffer = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut buffer, quality);
    encoder
        .encode(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{codecs::png::PngEncoder, ImageEncoder, Rgba, RgbaImage};

    /// A noisy image, which is what defeats PNG: a photo or a rendered scene
    /// compresses to megabytes losslessly, which is exactly the file that blew
    /// the caps.
    fn noisy_png(width: u32, height: u32) -> Vec<u8> {
        let mut image = RgbImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            // Deterministic pseudo-noise: no two neighbours agree, so there is
            // nothing for PNG's filters to predict.
            let seed = x
                .wrapping_mul(2_654_435_761)
                .wrapping_add(y.wrapping_mul(40_503));
            *pixel = Rgb([(seed >> 3) as u8, (seed >> 11) as u8, (seed >> 19) as u8]);
        }
        let mut buffer = Vec::new();
        PngEncoder::new(&mut buffer)
            .write_image(image.as_raw(), width, height, ExtendedColorType::Rgb8)
            .expect("png encodes");
        buffer
    }

    fn flat_png(width: u32, height: u32) -> Vec<u8> {
        let image = RgbImage::from_pixel(width, height, Rgb([12, 34, 56]));
        let mut buffer = Vec::new();
        PngEncoder::new(&mut buffer)
            .write_image(image.as_raw(), width, height, ExtendedColorType::Rgb8)
            .expect("png encodes");
        buffer
    }

    #[test]
    fn a_small_image_is_passed_through_byte_for_byte() {
        // The common case: a modest screenshot. Text survives lossless PNG
        // better than any JPEG, so within budget we must not touch it.
        let png = flat_png(400, 300);
        let fitted = fit_image_for_model(png.clone(), "image/png", 1_000_000);
        assert_eq!(fitted.mime_type, "image/png");
        assert_eq!(fitted.bytes, png);
    }

    #[test]
    fn an_oversized_image_is_cut_to_fit_the_budget() {
        // The reported failure, reproduced: a 1024x1024 image whose PNG is
        // megabytes. Before this, it went out whole and every size gate
        // downstream rejected the request as if the prompt were too long.
        let png = noisy_png(1024, 1024);
        assert!(png.len() > 1_500_000, "fixture must exceed the budget");

        let budget = 750_000;
        let fitted = fit_image_for_model(png, "image/png", budget);

        assert_eq!(fitted.mime_type, "image/jpeg");
        assert!(fitted.bytes.len() <= budget);
        // And it is still a real image, at usable resolution.
        let decoded = decode(&fitted.bytes).expect("re-encoded image decodes");
        assert!(decoded.width().max(decoded.height()) >= 768);
    }

    #[test]
    fn the_result_clears_the_character_caps_it_has_to_pass() {
        // The gate that actually rejected the user's turn is counted in base64
        // characters, not bytes — so assert on the encoded length.
        let fitted = fit_image_for_model(noisy_png(1024, 1024), "image/png", 750_000);
        assert!(
            fitted.encoded_len() < 1_500_000,
            "must clear MAX_AGENT_STRING_CHARS"
        );
    }

    #[test]
    fn a_huge_image_is_scaled_down_even_when_its_bytes_fit() {
        // A flat 4000px image compresses to almost nothing, so bytes alone would
        // wave it through — but the dimensions are past what any provider wants.
        let png = flat_png(4000, 3000);
        assert!(
            png.len() < 750_000,
            "fixture must be within budget on bytes"
        );

        let fitted = fit_image_for_model(png, "image/png", 750_000);

        let decoded = decode(&fitted.bytes).expect("fitted image decodes");
        assert!(decoded.width() <= MODEL_IMAGE_MAX_EDGE);
        assert_eq!(
            decoded.width(),
            MODEL_IMAGE_MAX_EDGE,
            "long edge is the bound"
        );
        // Aspect ratio survives: 4000x3000 is 4:3.
        assert_eq!(decoded.height(), MODEL_IMAGE_MAX_EDGE * 3 / 4);
    }

    #[test]
    fn transparency_lands_on_white_not_black() {
        // JPEG has no alpha. Dropping the channel would render a transparent
        // background black and swallow the dark UI text a screenshot carries.
        let mut image = RgbaImage::from_pixel(64, 64, Rgba([0, 0, 0, 0]));
        image.put_pixel(0, 0, Rgba([0, 0, 0, 255]));
        let flattened = flatten_onto_white(&DynamicImage::ImageRgba8(image));

        assert_eq!(flattened.get_pixel(10, 10), &Rgb([255, 255, 255]));
        // A fully opaque pixel is untouched.
        assert_eq!(flattened.get_pixel(0, 0), &Rgb([0, 0, 0]));
    }

    #[test]
    fn an_undecodable_file_comes_back_untouched() {
        // Fitting is an optimization, never a gate: garbage in, garbage out,
        // and the caller's own error path still reports it.
        let junk = vec![0u8; 900_000];
        let fitted = fit_image_for_model(junk.clone(), "image/png", 1000);
        assert_eq!(fitted.bytes, junk);
        assert_eq!(fitted.mime_type, "image/png");
    }

    #[test]
    fn an_unreachable_budget_still_yields_the_smallest_encode() {
        // A budget no encode can meet must not resurrect the original file:
        // sending the smallest attempt keeps the request as close to legal as
        // it can get.
        let png = noisy_png(1024, 1024);
        let fitted = fit_image_for_model(png.clone(), "image/png", 1);
        assert!(fitted.bytes.len() < png.len());
        assert_eq!(fitted.mime_type, "image/jpeg");
    }
}
