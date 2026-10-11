//! The chat's own picture (`generate_image`, the desktop composer's image
//! mode), sent where every other generation leaves the app:
//! [`crate::carpe_diem::media::send`]. That is where protected mode
//! (ADR-0084) is enforced, so the chat's picture is refused an adult model,
//! has `safe_mode` forced on, and stops for the image switch and for quiet
//! hours exactly as Studio and the agent's media tools do. It used to go
//! through the sidecar's `/v1/image/generate`, past all of that.

use base64::Engine as _;
use serde_json::{json, Value};

use crate::carpe_diem::media::{self, MediaResponseDto};
use crate::domain::types::AppError;
use crate::june_api::GeneratedImageDto;

/// The path the picture is asked on: one of the paths protected mode forces
/// `safe_mode` on, and an `/image/` path the image switch covers.
pub(crate) const PATH: &str = "/image/generate";
/// PNG, as the sidecar asked for it, so the chat's data URL is unchanged.
const FORMAT: &str = "png";
const MIME: &str = "image/png";

pub(crate) fn request_body(prompt: &str, model: &str) -> Value {
    json!({ "prompt": prompt, "model": model, "format": FORMAT })
}

/// The first picture of a generation, or the operator's own words when it
/// refused.
pub(crate) fn image_of(
    response: &MediaResponseDto,
    model: &str,
) -> Result<GeneratedImageDto, AppError> {
    if !response.ok {
        let said = response
            .json
            .as_ref()
            .and_then(|json| json.get("error"))
            .and_then(|error| error.as_str().or_else(|| error.get("message")?.as_str()))
            .map(str::to_string);
        return Err(match said {
            Some(message) => AppError::new("image_generation_failed", message),
            None => not_generated(),
        });
    }
    let image_base64 = match (&response.json, &response.body_base64) {
        (Some(json), _) => media::image_result(json).map(str::to_string),
        // Returned as bytes rather than JSON: already the picture.
        (None, Some(bytes)) => Some(bytes.clone()),
        (None, None) => None,
    }
    .filter(|encoded| {
        base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .is_ok_and(|bytes| !bytes.is_empty())
    })
    .ok_or_else(not_generated)?;
    Ok(GeneratedImageDto {
        image_base64,
        mime_type: MIME.to_string(),
        model: model.to_string(),
        provider: "carpe-diem".to_string(),
    })
}

fn not_generated() -> AppError {
    AppError::new(
        "image_generation_failed",
        "The image could not be generated. Try again.",
    )
}

pub(crate) async fn generate(prompt: &str, model: &str) -> Result<GeneratedImageDto, AppError> {
    let response = media::send("POST", PATH, Some(&request_body(prompt, model))).await?;
    image_of(&response, model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protected_mode::guards::guard_media_body;
    use crate::protected_mode::restrictions::{check_media, Restrictions};

    /// What the chat's picture sends is a request every protected-mode rule
    /// reads: the adult model refused, `safe_mode` forced, the image switch
    /// and quiet hours applied.
    #[test]
    fn the_chat_picture_is_a_request_protected_mode_governs() {
        let refused =
            guard_media_body(PATH, Some(&request_body("a cat", "lustify-sdxl")), true).unwrap_err();
        assert_eq!(refused.code, "protected_mode_model");
        let forced = guard_media_body(PATH, Some(&request_body("a cat", "flux-dev")), true)
            .unwrap()
            .expect("safe_mode is forced");
        assert_eq!(forced["safe_mode"], true);
        assert_eq!(forced["prompt"], "a cat");
        assert!(
            guard_media_body(PATH, Some(&request_body("a cat", "flux-dev")), false)
                .unwrap()
                .is_none()
        );
        let media_off = Restrictions {
            media_off: true,
            ..Restrictions::default()
        };
        assert_eq!(
            check_media(PATH, true, &media_off, 600).unwrap_err().code,
            "protected_mode_media_off"
        );
        let quiet: Restrictions = serde_json::from_value(serde_json::json!({
            "quietHours": { "startMinute": 0, "endMinute": 1439 },
        }))
        .unwrap();
        assert_eq!(
            check_media(PATH, true, &quiet, 600).unwrap_err().code,
            "protected_mode_quiet_hours"
        );
    }

    #[test]
    fn the_first_picture_is_kept_and_a_refusal_is_said() {
        let png = base64::engine::general_purpose::STANDARD.encode([137_u8, 80, 78, 71]);
        let ok = MediaResponseDto {
            status: 200,
            ok: true,
            json: Some(json!({ "images": [png.clone(), "ignored"] })),
            body_base64: None,
            content_type: None,
            retry_after_ms: None,
        };
        let image = image_of(&ok, "flux-dev").unwrap();
        assert_eq!(image.image_base64, png);
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.model, "flux-dev");
        let refused = MediaResponseDto {
            status: 400,
            ok: false,
            json: Some(json!({ "error": "Prompt rejected" })),
            ..ok.clone()
        };
        assert_eq!(
            image_of(&refused, "flux-dev").unwrap_err().message,
            "Prompt rejected"
        );
        let empty = MediaResponseDto {
            json: Some(json!({ "images": [] })),
            ..ok
        };
        assert_eq!(
            image_of(&empty, "flux-dev").unwrap_err().code,
            "image_generation_failed"
        );
    }
}
