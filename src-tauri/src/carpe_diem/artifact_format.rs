//! Recognize generated media without trusting the requested format. Some
//! models ignore it (Flux can return JPEG for a PNG request, ACE-Step FLAC
//! for an MP3 request). This identifies the container; it does not transcode.

/// Keep only the signature, skipping ID3 metadata as bytes arrive. ID3 is not
/// proof of MP3: ACE-Step returns ID3 followed by FLAC (observed live).
#[derive(Default)]
pub(super) struct Probe {
    prefix: [u8; 16],
    len: usize,
    skip: usize,
    header_checked: bool,
}

impl Probe {
    pub(super) fn push(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() && self.len < self.prefix.len() {
            let skipped = self.skip.min(bytes.len());
            self.skip -= skipped;
            bytes = &bytes[skipped..];
            if bytes.is_empty() {
                break;
            }
            let target = if self.header_checked { 16 } else { 10 };
            let take = (target - self.len).min(bytes.len());
            self.prefix[self.len..self.len + take].copy_from_slice(&bytes[..take]);
            self.len += take;
            bytes = &bytes[take..];
            if self.len == 10 && !self.header_checked {
                if self.prefix.starts_with(b"ID3")
                    && matches!(self.prefix[3], 2..=4)
                    && self.prefix[6..10].iter().all(|byte| byte & 0x80 == 0)
                {
                    self.skip = self.prefix[6..10]
                        .iter()
                        .fold(0, |size, byte| (size << 7) | usize::from(*byte));
                    if self.prefix[3] == 4 && self.prefix[5] & 0x10 != 0 {
                        self.skip += 10; // ID3v2.4 footer, outside the tag size.
                    }
                    self.len = 0;
                } else {
                    self.header_checked = true;
                }
            }
        }
    }

    pub(super) fn extension<'a>(&self, requested: &'a str) -> &'a str {
        extension(&self.prefix[..self.len], requested)
    }
}

pub(super) fn extension<'a>(prefix: &[u8], requested: &'a str) -> &'a str {
    if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if prefix.starts_with(b"\xff\xd8\xff") {
        if requested == "jpeg" {
            "jpeg"
        } else {
            "jpg"
        }
    } else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP") {
        "webp"
    } else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WAVE") {
        "wav"
    } else if prefix.starts_with(b"fLaC") {
        "flac"
    } else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        "gif"
    } else if prefix.get(4..12) == Some(b"ftypM4A ") {
        "m4a"
    } else {
        // Raw PCM and ambiguous containers carry no definitive signature.
        // Preserve the caller's validated extension rather than guessing.
        requested
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_signature_overrides_requested_image_or_audio_format() {
        for (bytes, requested, expected) in [
            (b"\xff\xd8\xff\xe0".as_slice(), "png", "jpg"),
            (b"\x89PNG\r\n\x1a\n", "webp", "png"),
            (b"RIFF\x00\x00\x00\x00WEBP", "png", "webp"),
            (b"RIFF\x00\x00\x00\x00WAVE", "mp3", "wav"),
            (b"fLaC\x00\x00", "mp3", "flac"),
            (b"GIF89a", "png", "gif"),
            (b"\x00\x00\x00\x18ftypM4A ", "mp3", "m4a"),
        ] {
            assert_eq!(extension(bytes, requested), expected);
        }
    }

    #[test]
    fn unknown_or_ambiguous_bytes_keep_the_validated_request() {
        for bytes in [b"".as_slice(), b"RIFF", b"\x00\x00\x00\x18ftypisom"] {
            assert_eq!(extension(bytes, "mp4"), "mp4");
        }
        assert_eq!(extension(b"\xff\xd8\xff\xe0", "jpeg"), "jpeg");
    }

    #[test]
    fn id3_tagged_flac_is_recognized_across_every_chunk_boundary() {
        let mut payload = b"ID3\x04\x00\x00\x00\x00\x00\x04tagsfLaC".to_vec();
        payload.extend_from_slice(&[0; 32]);
        for chunk_size in 1..=payload.len() {
            let mut probe = Probe::default();
            for chunk in payload.chunks(chunk_size) {
                probe.push(chunk);
            }
            assert_eq!(probe.extension("mp3"), "flac", "chunks of {chunk_size}");
        }
    }

    #[test]
    fn tagged_and_untagged_outputs_preserve_their_real_signature() {
        for payload in [
            b"fLaC".as_slice(),
            b"ID3\x04\x00\x10\x00\x00\x00\x00footer1234fLaC",
        ] {
            let mut probe = Probe::default();
            probe.push(payload);
            assert_eq!(probe.extension("mp3"), "flac");
        }
        let mut truncated = Probe::default();
        truncated.push(b"ID3\x04\x00\x00\x00\x00\x01\x00");
        assert_eq!(truncated.extension("mp3"), "mp3");
    }
}
