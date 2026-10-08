//! The rule set public content passes before it is stored (ADR 0097,
//! `docs/public-content-rules.md`). There is no model here and no judgement:
//! each rule is mechanical, documented, and named in the refusal, so a person
//! knows what to change. What the rules cannot catch is what the report button
//! and the operator's takedown tool are for.
use subrosa_domain::publication::PolicyRule;

/// The caps. A page is a long article at most; a catalog listing is a
/// definition, not a library.
pub const MAX_PAGE_SOURCE_BYTES: usize = 256 * 1024;
pub const MAX_PAGE_HTML_BYTES: usize = 512 * 1024;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_PAGES: i64 = 500;
pub const MAX_SITES: i64 = 20;
pub const MAX_SITE_PAGES: usize = 100;
pub const MAX_LISTINGS: i64 = 50;
pub const MAX_NAME_CHARS: usize = 100;
pub const MAX_DESCRIPTION_CHARS: usize = 500;
pub const MAX_INSTRUCTIONS_BYTES: usize = 32 * 1024;
pub const MAX_STARTER_BYTES: usize = 2 * 1024;
pub const MAX_PERMISSIONS: usize = 16;
pub const MAX_REFERENCES: usize = 10;
pub const MAX_REFERENCES_BYTES: usize = 200 * 1024;
pub const MAX_DISPLAY_NAME_CHARS: usize = 80;
pub const MAX_BIO_CHARS: usize = 500;
pub const MAX_AVATAR_BYTES: usize = 256 * 1024;
pub const MAX_REPORT_DETAIL_CHARS: usize = 500;
/// Takedowns after which an account may no longer publish.
pub const SUSPENSION_TAKEDOWNS: i64 = 3;
/// A link farm, not an article: more than this many links...
const LINK_FLOOR: usize = 20;
/// ...and more than one per this many characters.
const CHARS_PER_LINK: usize = 80;

/// Every text rule, over every field of one publication at once.
pub fn check_text(fields: &[&str], blocked_terms: &[String]) -> Result<(), PolicyRule> {
    for field in fields {
        if field
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            return Err(PolicyRule::ControlCharacters);
        }
        if looks_like_a_credential(field) {
            return Err(PolicyRule::Credential);
        }
        let links = ["http://", "https://", "www."]
            .iter()
            .map(|marker| field.matches(marker).count())
            .sum::<usize>();
        if links > LINK_FLOOR && links * CHARS_PER_LINK > field.chars().count() {
            return Err(PolicyRule::TooManyLinks);
        }
    }
    if !blocked_terms.is_empty() {
        let text = fields.join("\n").to_lowercase();
        if blocked_terms
            .iter()
            .map(|term| term.trim().to_lowercase())
            .any(|term| !term.is_empty() && text.contains(&term))
        {
            return Err(PolicyRule::BlockedTerm);
        }
    }
    Ok(())
}

/// A short required field: trimmed, not empty, and under its cap in
/// characters.
pub fn required(value: &str, max_chars: usize) -> Result<String, PolicyRule> {
    let value = value.trim();
    if value.is_empty() {
        return Err(PolicyRule::Empty);
    }
    if value.chars().count() > max_chars {
        return Err(PolicyRule::TooLarge);
    }
    Ok(value.to_string())
}

/// What people paste by accident: an API key, an access token, a private key.
/// Publishing one is never what anybody meant, and it cannot be taken back
/// once a crawler has it.
pub fn looks_like_a_credential(text: &str) -> bool {
    const PEM: &str = concat!("-----BEGIN ", "PRIVATE KEY-----");
    const PEM_TYPED: &str = concat!(" PRIVATE KEY", "-----");
    if text.contains(PEM) || (text.contains("-----BEGIN ") && text.contains(PEM_TYPED)) {
        return true;
    }
    let token = |prefix: &str, min: usize, charset: fn(char) -> bool| {
        text.match_indices(prefix).any(|(at, _)| {
            let boundary = text[..at]
                .chars()
                .next_back()
                .is_none_or(|c| !c.is_ascii_alphanumeric());
            boundary
                && text[at + prefix.len()..]
                    .chars()
                    .take_while(|c| charset(*c))
                    .count()
                    >= min
        })
    };
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let upper = |c: char| c.is_ascii_uppercase() || c.is_ascii_digit();
    token("cdm_", 24, word)
        || token("sk-", 32, word)
        || token("ghp_", 36, word)
        || token("github_pat_", 40, word)
        || token("xoxb-", 24, word)
        || token("xoxp-", 24, word)
        || token("AKIA", 16, upper)
}

/// The image formats a profile may carry, by their first bytes, never by what
/// the upload claims to be.
pub fn avatar_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pasted_key_is_refused_and_prose_about_keys_is_not() {
        let key = format!("my key is cdm_{}", "a1".repeat(16));
        assert!(looks_like_a_credential(&key));
        assert!(looks_like_a_credential(&format!(
            "{}\nMIIE\n-----END",
            concat!("-----BEGIN RSA", " PRIVATE KEY-----")
        )));
        assert!(looks_like_a_credential("AKIAABCDEFGHIJKLMNOP"));
        assert!(!looks_like_a_credential(
            "Paste your cdm_ key in Settings, never in a note."
        ));
        assert!(!looks_like_a_credential("a task-list for the sk-team"));
        assert!(!looks_like_a_credential("BAKIAABCDEFGHIJKLMNOP"));
    }

    #[test]
    fn a_link_farm_is_refused_and_a_reading_list_is_not() {
        let farm = "https://spam.example ".repeat(30);
        assert_eq!(check_text(&[&farm], &[]), Err(PolicyRule::TooManyLinks));
        let list = "- [A chapter](https://book.example/chapter), which explains a part of the argument in some detail\n".repeat(30);
        assert_eq!(check_text(&[&list], &[]), Ok(()));
    }

    #[test]
    fn control_characters_and_blocked_terms_are_named() {
        assert_eq!(
            check_text(&["a\u{0007}b"], &[]),
            Err(PolicyRule::ControlCharacters)
        );
        assert_eq!(check_text(&["line\n\tindented"], &[]), Ok(()));
        assert_eq!(
            check_text(&["Buy CHEAP pills"], &["cheap pills".into()]),
            Err(PolicyRule::BlockedTerm)
        );
        assert_eq!(check_text(&["fine"], &["  ".into()]), Ok(()));
    }

    #[test]
    fn required_fields_are_trimmed_and_capped() {
        assert_eq!(required("  Hello ", 10), Ok("Hello".into()));
        assert_eq!(required("   ", 10), Err(PolicyRule::Empty));
        assert_eq!(required("ééééé", 4), Err(PolicyRule::TooLarge));
    }

    #[test]
    fn an_avatar_is_known_by_its_bytes() {
        assert_eq!(avatar_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(avatar_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(avatar_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(avatar_type(b"<svg onload=alert(1)>"), None);
        assert_eq!(avatar_type(b"GIF89a"), None);
    }
}
