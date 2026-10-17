//! A workflow written into a file it made, on request (the gallery's "Save a
//! copy with its workflow"): dropping the copy on the workflow library opens
//! the same graph again, the way a picture ComfyUI saved carries its own.
//!
//! The workflow goes under Sub Rosa's own key, never ComfyUI's `workflow`,
//! so ComfyUI does not try to read a graph it cannot run. Only the copy the
//! person saves carries it: the gallery file is never touched, because the
//! workflow holds every prompt and setting of the graph and leaving the
//! device with them is the person's call each time.
//!
//! Each container gets the place its readers skip: a PNG `iTXt` chunk before
//! `IEND`, a JPEG comment segment after the start marker, a RIFF chunk at the
//! end of a WebP, a top-level `uuid` box at the end of an MP4 or a MOV.

use crate::domain::types::AppError;

/// The key the workflow is stored under (PNG keyword, and the marker the
/// importer looks for elsewhere).
pub const KEYWORD: &str = "subrosa-workflow";

/// The largest workflow worth carrying: the importer's file limit.
pub const MAX_WORKFLOW_BYTES: usize = 5 * 1024 * 1024;

/// The `uuid` box type Sub Rosa writes into MP4 and MOV files.
const BOX_UUID: [u8; 16] = *b"subrosa-workflow";

/// The RIFF chunk a WebP carries the workflow in.
const RIFF_CHUNK: &[u8; 4] = b"SRWF";

fn refused(message: String) -> AppError {
    AppError::new("media_artifact_embed_failed", message)
}

/// The file's bytes with the workflow written in, chosen by its extension.
pub fn embed_workflow(bytes: &[u8], extension: &str, workflow: &str) -> Result<Vec<u8>, AppError> {
    if workflow.len() > MAX_WORKFLOW_BYTES {
        return Err(refused(crate::tr!(
            "This workflow is too large to put in the file."
        )));
    }
    let embedded = match extension.to_ascii_lowercase().as_str() {
        "png" => png(bytes, workflow),
        "jpg" | "jpeg" => jpeg(bytes, workflow),
        "webp" => webp(bytes, workflow),
        "mp4" | "m4v" | "mov" => iso_box(bytes, workflow),
        _ => None,
    };
    embedded.ok_or_else(|| {
        refused(crate::tr!(
            "This kind of file cannot carry a workflow. Save a copy without it."
        ))
    })
}

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// An uncompressed `iTXt` chunk (UTF-8 text) inserted before `IEND`.
fn png(bytes: &[u8], workflow: &str) -> Option<Vec<u8>> {
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return None;
    }
    let mut offset = PNG_SIGNATURE.len();
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().ok()?) as usize;
        let kind = &bytes[offset + 4..offset + 8];
        if kind == b"IEND" {
            // keyword \0 compression-flag compression-method language \0 translated \0 text
            let mut data = Vec::with_capacity(KEYWORD.len() + 5 + workflow.len());
            data.extend_from_slice(KEYWORD.as_bytes());
            data.extend_from_slice(&[0, 0, 0, 0, 0]);
            data.extend_from_slice(workflow.as_bytes());
            let mut out = Vec::with_capacity(bytes.len() + data.len() + 12);
            out.extend_from_slice(&bytes[..offset]);
            out.extend_from_slice(&u32::try_from(data.len()).ok()?.to_be_bytes());
            let mut crc_input = Vec::with_capacity(data.len() + 4);
            crc_input.extend_from_slice(b"iTXt");
            crc_input.extend_from_slice(&data);
            out.extend_from_slice(&crc_input);
            out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
            out.extend_from_slice(&bytes[offset..]);
            return Some(out);
        }
        offset = offset.checked_add(12 + length)?;
    }
    None
}

/// The CRC a PNG chunk ends with (ISO 3309, as the PNG specification gives it).
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// One comment segment after the start-of-image marker. A segment holds at
/// most 65,533 bytes, and a workflow cut over several would not read back
/// as one, so a larger one is refused.
fn jpeg(bytes: &[u8], workflow: &str) -> Option<Vec<u8>> {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let length = u16::try_from(workflow.len() + 2).ok()?;
    let mut out = Vec::with_capacity(bytes.len() + workflow.len() + 4);
    out.extend_from_slice(&bytes[..2]);
    out.extend_from_slice(&[0xFF, 0xFE]);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(workflow.as_bytes());
    out.extend_from_slice(&bytes[2..]);
    Some(out)
}

/// A chunk of its own at the end of the RIFF container, whose size is grown
/// to match. Readers skip chunks they do not know.
fn webp(bytes: &[u8], workflow: &str) -> Option<Vec<u8>> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let declared = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
    // Only a file that ends where its header says it does.
    if declared + 8 != bytes.len() {
        return None;
    }
    let payload = workflow.as_bytes();
    let padded = payload.len() + payload.len() % 2;
    let mut out = Vec::with_capacity(bytes.len() + padded + 8);
    out.extend_from_slice(&bytes[..4]);
    out.extend_from_slice(&u32::try_from(declared + 8 + padded).ok()?.to_le_bytes());
    out.extend_from_slice(&bytes[8..]);
    out.extend_from_slice(RIFF_CHUNK);
    out.extend_from_slice(&u32::try_from(payload.len()).ok()?.to_le_bytes());
    out.extend_from_slice(payload);
    if payload.len() % 2 == 1 {
        out.push(0);
    }
    Some(out)
}

/// A top-level `uuid` box at the end of an ISO media file (MP4, MOV), which
/// players skip.
fn iso_box(bytes: &[u8], workflow: &str) -> Option<Vec<u8>> {
    // An ISO media file opens with a box whose type is `ftyp` (MP4) or one of
    // the QuickTime atoms.
    if bytes.len() < 8
        || !matches!(
            &bytes[4..8],
            b"ftyp" | b"moov" | b"wide" | b"mdat" | b"free"
        )
    {
        return None;
    }
    let size = u32::try_from(8 + 16 + workflow.len()).ok()?;
    let mut out = Vec::with_capacity(bytes.len() + size as usize);
    out.extend_from_slice(bytes);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(b"uuid");
    out.extend_from_slice(&BOX_UUID);
    out.extend_from_slice(workflow.as_bytes());
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKFLOW: &str = r#"{"format":"subrosa-workflow","version":2,"workflow":{"name":"Café","nodes":[],"edges":[]}}"#;

    fn encoded(format: image::ImageFormat) -> Vec<u8> {
        let picture = image::RgbImage::from_pixel(4, 3, image::Rgb([200, 30, 60]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(picture)
            .write_to(&mut out, format)
            .unwrap();
        out.into_inner()
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    #[test]
    fn a_png_carries_the_workflow_in_a_valid_chunk_and_still_opens() {
        let original = encoded(image::ImageFormat::Png);
        let written = embed_workflow(&original, "PNG", WORKFLOW).unwrap();
        assert!(contains(&written, WORKFLOW.as_bytes()));
        assert!(contains(&written, b"iTXtsubrosa-workflow\0\0\0\0\0"));
        // The png decoder checks every chunk's CRC.
        let decoded = image::load_from_memory_with_format(&written, image::ImageFormat::Png);
        assert_eq!(decoded.unwrap().to_rgb8().get_pixel(0, 0).0, [200, 30, 60]);
        assert!(written.ends_with(&original[original.len() - 12..]));
    }

    #[test]
    fn the_chunk_crc_is_the_png_one() {
        // The CRC of an empty IEND chunk, as every PNG ends.
        assert_eq!(crc32(b"IEND"), 0xAE42_6082);
    }

    #[test]
    fn a_jpeg_carries_it_in_a_comment_and_still_opens() {
        let original = encoded(image::ImageFormat::Jpeg);
        let written = embed_workflow(&original, "jpg", WORKFLOW).unwrap();
        assert!(contains(&written, WORKFLOW.as_bytes()));
        assert!(image::load_from_memory_with_format(&written, image::ImageFormat::Jpeg).is_ok());
        let too_large = "x".repeat(70_000);
        assert!(embed_workflow(&original, "jpeg", &too_large).is_err());
    }

    #[test]
    fn a_webp_carries_it_in_a_chunk_of_its_own_and_still_opens() {
        let original = encoded(image::ImageFormat::WebP);
        // Odd length, so the chunk is padded.
        let odd = format!("{WORKFLOW} ");
        let written = embed_workflow(&original, "webp", &odd).unwrap();
        assert!(contains(&written, odd.as_bytes()));
        let declared = u32::from_le_bytes(written[4..8].try_into().unwrap()) as usize;
        assert_eq!(declared + 8, written.len());
        assert!(image::load_from_memory_with_format(&written, image::ImageFormat::WebP).is_ok());
    }

    #[test]
    fn a_video_carries_it_in_a_box_at_the_end() {
        let mut original = Vec::new();
        original.extend_from_slice(&20u32.to_be_bytes());
        original.extend_from_slice(b"ftypisom\0\0\0\0isom");
        original.extend_from_slice(&8u32.to_be_bytes());
        original.extend_from_slice(b"mdat");
        let written = embed_workflow(&original, "mp4", WORKFLOW).unwrap();
        assert!(written.starts_with(&original));
        let tail = &written[original.len()..];
        let size = u32::from_be_bytes(tail[..4].try_into().unwrap()) as usize;
        assert_eq!(size, tail.len());
        assert_eq!(&tail[4..8], b"uuid");
        assert_eq!(&tail[24..], WORKFLOW.as_bytes());
    }

    #[test]
    fn other_files_and_mislabelled_ones_are_refused() {
        assert!(embed_workflow(b"ID3....", "mp3", WORKFLOW).is_err());
        assert!(embed_workflow(&encoded(image::ImageFormat::Png), "jpg", WORKFLOW).is_err());
        assert!(embed_workflow(b"not a png at all", "png", WORKFLOW).is_err());
    }
}
