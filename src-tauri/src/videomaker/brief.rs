//! AI brief development (fork addition): turn a rough film idea into a
//! production-ready brief before it is handed to the Videomaker crew.
//!
//! This never talks to the studio — it goes through the same sidecar
//! chat-completions proxy as every other in-app generation (the user's Carpe
//! Diem key, their chosen generation model). Attached reference images ride
//! along as multimodal parts so the model can anchor characters, locations,
//! and the visual style on what the user actually supplied; if the selected
//! model rejects image input, the command transparently retries text-only
//! rather than failing the improvement.

use crate::domain::types::AppError;
use crate::june_api;
use serde::Deserialize;
use serde_json::{json, Value};

/// Payload guard: the improver reads previews, not originals. The frontend
/// downscales picks before calling; anything bigger than this is a bug there.
const MAX_REF_PREVIEW_BYTES: usize = 2 * 1024 * 1024;
const MAX_REFS: usize = 4;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImproveBriefRequest {
    pub brief: String,
    pub title: Option<String>,
    pub aspect_ratio: Option<String>,
    pub target_duration_seconds: Option<u32>,
    /// `"brief"` (default): develop a full production brief. `"direction"`:
    /// sharpen a mid-project note to the crew (director chat) — same rigor,
    /// no 7-section rewrite of a two-line instruction.
    pub mode: Option<String>,
    /// Reference images already picked in the form (not yet uploaded — the
    /// improvement happens before the project exists).
    #[serde(default)]
    pub refs: Vec<BriefRef>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefRef {
    /// One of character / location / style / object (free-form tolerated).
    pub role: String,
    pub label: Option<String>,
    /// Downscaled `data:image/...;base64,...` preview for analysis.
    pub data_uri: Option<String>,
}

const SYSTEM_PROMPT: &str = "You are a demanding film development executive preparing a brief \
for an AI film studio that writes the bible, shotlist, and storyboard, then renders every shot. \
Rewrite the user's draft into a production-ready brief. Be exacting: make every creative choice \
concrete enough that two different directors would shoot the same film.\n\
Structure the brief with these sections (plain text, short headed paragraphs, no markdown \
tables):\n\
1. Logline - one sentence, protagonist + goal + obstacle.\n\
2. Story - beginning, middle, end, paced for the target duration; name the emotional turn.\n\
3. Characters - for each: name, age range, silhouette, face, wardrobe, one distinguishing \
detail that survives every shot.\n\
4. Locations - for each: time of day, weather, key props, what the camera sees in the \
background.\n\
5. Visual universe - style, palette (name 3-5 colors), lighting, lens/framing tendencies.\n\
6. Sound - music direction, ambiances, whether there is dialogue or voice-over.\n\
7. Constraints - target duration, aspect ratio, and pacing guidance: individual shots run 4 to \
15 seconds and must describe one continuous action in a single framing.\n\
Rules: write in the same language as the draft. Keep every fact the user stated; invent only \
what is missing, and prefer specific over generic (never 'a city', always which city, which \
era, which weather). If reference images are attached, describe each one precisely in the \
matching section and anchor the character/location/style on it, referring to it as 'Reference \
image N (role)'. Return ONLY the brief text - no preamble, no commentary, no code fences.";

const DIRECTION_SYSTEM_PROMPT: &str = "You are a film director's right hand, sharpening a note \
the director is about to send to an AI film studio crew mid-production. Rewrite the draft into \
a clear, actionable direction. Be exacting: name the exact scene, shot, character, or asset \
concerned when the draft implies one; turn vague wishes into concrete, verifiable instructions \
(never 'make it better', always what changes, where, and how it should look or sound); keep \
one direction per line when the draft mixes several. Keep the draft's intent, every stated \
fact, and its language. Do NOT pad it into a full brief, do NOT invent new creative demands \
the draft does not imply, and keep it at most a few sentences longer than the draft. If a \
reference image is attached or linked, say precisely what the crew should take from it. \
Return ONLY the note text - no preamble, no commentary, no code fences.";

/// One-shot brief development over the sidecar chat proxy. Returns the
/// improved brief text.
#[tauri::command]
pub async fn videomaker_improve_brief(request: ImproveBriefRequest) -> Result<String, AppError> {
    let draft = request.brief.trim();
    if draft.is_empty() {
        return Err(AppError::new(
            "videomaker_invalid",
            "Write a first draft of the brief before improving it.",
        ));
    }

    let mut context_lines: Vec<String> = Vec::new();
    if let Some(title) = request.title.as_deref().map(str::trim) {
        if !title.is_empty() {
            context_lines.push(format!("Working title: {title}"));
        }
    }
    if let Some(seconds) = request.target_duration_seconds {
        context_lines.push(format!("Target duration: {seconds} seconds"));
    }
    if let Some(ratio) = request.aspect_ratio.as_deref().map(str::trim) {
        if !ratio.is_empty() {
            context_lines.push(format!("Aspect ratio: {ratio}"));
        }
    }
    let refs: Vec<&BriefRef> = request.refs.iter().take(MAX_REFS).collect();
    let (ref_lines, previews) = ref_context(&refs);
    context_lines.extend(ref_lines);
    let system = system_prompt(request.mode.as_deref());
    let draft_heading = if matches!(request.mode.as_deref(), Some("direction")) {
        "Draft note to the crew"
    } else {
        "Draft brief"
    };
    let user_text = format!("{}\n\n{draft_heading}:\n{draft}", context_lines.join("\n"));

    let image_parts: Vec<Value> = previews
        .iter()
        .map(|uri| json!({ "type": "image_url", "image_url": { "url": uri } }))
        .collect();

    if !image_parts.is_empty() {
        let mut content = vec![json!({ "type": "text", "text": user_text })];
        content.extend(image_parts);
        if let Ok(text) = complete(json!([
            { "role": "system", "content": system },
            { "role": "user", "content": content }
        ]))
        .await
        {
            return Ok(text);
        }
        // Vision refusal (or any upstream hiccup) must not cost the user the
        // improvement — the roles/labels above still describe the refs.
    }
    complete(json!([
        { "role": "system", "content": system },
        { "role": "user", "content": user_text }
    ]))
    .await
}

/// The preview that will actually ride with the request, if any. The frontend
/// downscales every pick before calling, so a missing or oversized data URI is
/// the exception, not the rule.
fn ref_preview(reference: &BriefRef) -> Option<&str> {
    reference
        .data_uri
        .as_deref()
        .filter(|uri| uri.starts_with("data:image/") && uri.len() <= MAX_REF_PREVIEW_BYTES)
}

/// Context lines naming the picked references, plus the previews to attach in
/// the same order.
///
/// The number is the reference's position in the create form — the same one
/// `buildRefsManifest` hands the crew and the same one the form now prints on
/// each card. The three have to agree, or "Reference image 2" in the improved
/// brief anchors a different image than the crew resolves later. So a
/// reference whose preview cannot ride along keeps its number and is marked
/// unattached rather than renumbering the ones after it; the trailing note
/// tells the model how to line the images it did receive up with the list.
fn ref_context<'a>(refs: &[&'a BriefRef]) -> (Vec<String>, Vec<&'a str>) {
    let mut lines: Vec<String> = Vec::with_capacity(refs.len());
    let mut previews: Vec<&'a str> = Vec::with_capacity(refs.len());
    for (index, reference) in refs.iter().copied().enumerate() {
        let label = reference
            .label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(|label| format!(" \"{label}\""))
            .unwrap_or_default();
        let preview = ref_preview(reference);
        lines.push(format!(
            "Reference image {} ({}{}): {}",
            index + 1,
            reference.role.trim(),
            label,
            if preview.is_some() {
                "attached"
            } else {
                "not attached, no image to look at"
            }
        ));
        if let Some(preview) = preview {
            previews.push(preview);
        }
    }
    if !previews.is_empty() && previews.len() < refs.len() {
        lines.push(
            "The attached images come in that order, skipping the references marked not attached."
                .to_string(),
        );
    }
    (lines, previews)
}

/// Unknown modes fall back to the full brief treatment (the safer, richer
/// output) rather than erroring on a stale frontend.
fn system_prompt(mode: Option<&str>) -> &'static str {
    match mode {
        Some("direction") => DIRECTION_SYSTEM_PROMPT,
        _ => SYSTEM_PROMPT,
    }
}

async fn complete(messages: Value) -> Result<String, AppError> {
    let response = june_api::proxy_agent_chat_completions(json!({
        "messages": messages,
        "temperature": 0.6,
        // Sized for reasoning models: hidden thinking spends from the same
        // budget as the brief itself.
        "max_tokens": 4000
    }))
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            "videomaker_brief_failed",
            format!("Brief improvement returned status {}.", response.status),
        ));
    }
    let body = response.collect_body().await?;
    let value: Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new("videomaker_brief_invalid", error.to_string()))?;
    let text = june_api::extract_chat_completion_text(&value).ok_or_else(|| {
        AppError::new(
            "videomaker_brief_invalid",
            "Brief improvement did not return text.",
        )
    })?;
    let cleaned = clean_brief(&text);
    if cleaned.is_empty() {
        return Err(AppError::new(
            "videomaker_brief_invalid",
            "Brief improvement returned an empty brief.",
        ));
    }
    Ok(cleaned)
}

/// Strip a wrapping code fence if the model ignored the no-fences rule.
fn clean_brief(text: &str) -> String {
    let trimmed = text.trim();
    let Some(inner) = trimmed
        .strip_prefix("```")
        .and_then(|rest| rest.strip_suffix("```"))
    else {
        return trimmed.to_string();
    };
    // Drop an optional language tag on the fence line.
    let inner = inner
        .split_once('\n')
        .map(|(_, body)| body)
        .unwrap_or(inner);
    inner.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brief_ref(role: &str, label: Option<&str>, data_uri: Option<String>) -> BriefRef {
        BriefRef {
            role: role.to_string(),
            label: label.map(str::to_string),
            data_uri,
        }
    }

    #[test]
    fn ref_context_numbers_by_form_position_even_when_a_preview_is_dropped() {
        let oversized = format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_REF_PREVIEW_BYTES)
        );
        let refs = [
            brief_ref("character", Some("Marc"), Some(oversized)),
            brief_ref(
                "location",
                None,
                Some("data:image/png;base64,ok".to_string()),
            ),
            brief_ref("style", Some(" "), None),
        ];
        let borrowed: Vec<&BriefRef> = refs.iter().collect();
        let (lines, previews) = ref_context(&borrowed);

        // The location keeps number 2, the number the crew manifest and the
        // create form use for it, instead of sliding up to 1.
        assert_eq!(
            lines[0],
            "Reference image 1 (character \"Marc\"): not attached, no image to look at"
        );
        assert_eq!(lines[1], "Reference image 2 (location): attached");
        assert_eq!(
            lines[2],
            "Reference image 3 (style): not attached, no image to look at"
        );
        assert!(lines[3].starts_with("The attached images come in that order"));
        assert_eq!(previews, vec!["data:image/png;base64,ok"]);
    }

    #[test]
    fn ref_context_skips_the_ordering_note_when_every_preview_rides_along() {
        let refs = [
            brief_ref(
                "character",
                None,
                Some("data:image/png;base64,a".to_string()),
            ),
            brief_ref("style", None, Some("data:image/png;base64,b".to_string())),
        ];
        let borrowed: Vec<&BriefRef> = refs.iter().collect();
        let (lines, previews) = ref_context(&borrowed);

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1], "Reference image 2 (style): attached");
        assert_eq!(previews.len(), 2);
    }

    #[test]
    fn clean_brief_strips_a_wrapping_fence_and_language_tag() {
        assert_eq!(clean_brief("```text\nLogline: x\n```"), "Logline: x");
        assert_eq!(clean_brief("```\nLogline: x\n```"), "Logline: x");
        assert_eq!(clean_brief("  Logline: x  "), "Logline: x");
    }

    #[test]
    fn direction_mode_picks_the_note_prompt_and_unknown_modes_fall_back() {
        assert_eq!(system_prompt(Some("direction")), DIRECTION_SYSTEM_PROMPT);
        assert_eq!(system_prompt(Some("brief")), SYSTEM_PROMPT);
        assert_eq!(system_prompt(Some("weird")), SYSTEM_PROMPT);
        assert_eq!(system_prompt(None), SYSTEM_PROMPT);
    }
}
