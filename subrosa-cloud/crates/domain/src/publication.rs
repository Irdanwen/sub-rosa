//! Public content (ADR 0097): pages, sites, the opt-in profile and the
//! assistant catalog. Unlike everything else the service holds, this is
//! plaintext, because it is meant to be read by anybody.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The catalog's categories. A fixed list, so a category page is a real place
/// and not whatever somebody typed.
pub const CATEGORIES: &[&str] = &[
    "writing",
    "research",
    "learning",
    "productivity",
    "creative",
    "coding",
    "lifestyle",
    "other",
];

/// Handles nobody may take: they read as the product or its operator.
pub const RESERVED_HANDLES: &[&str] = &[
    "admin",
    "administrator",
    "api",
    "auth",
    "carpe-diem",
    "carpediem",
    "help",
    "moderator",
    "official",
    "root",
    "security",
    "staff",
    "sub-rosa",
    "subrosa",
    "support",
    "system",
];

/// Which documented rule refused a publication. The client shows the rule, so
/// a person knows what to change rather than guessing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyRule {
    /// Over a size cap.
    TooLarge,
    /// A required field is empty.
    Empty,
    /// Control characters other than line breaks and tabs.
    ControlCharacters,
    /// More links than the text could plausibly need.
    TooManyLinks,
    /// Something that looks like a key or a password was about to go public.
    Credential,
    /// A term the operator blocks.
    BlockedTerm,
    /// A slug, handle, category or reason outside its allowed shape.
    Shape,
    /// The account holds as many of these as one account may.
    TooMany,
}
impl PolicyRule {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TooLarge => "too_large",
            Self::Empty => "empty",
            Self::ControlCharacters => "control_characters",
            Self::TooManyLinks => "too_many_links",
            Self::Credential => "credential",
            Self::BlockedTerm => "blocked_term",
            Self::Shape => "shape",
            Self::TooMany => "too_many",
        }
    }
}

/// A public address segment: lowercase ASCII letters, digits and single
/// hyphens, starting and ending with a letter or digit.
pub fn valid_slug(value: &str, min: usize, max: usize) -> bool {
    let bytes = value.as_bytes();
    (min..=max).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && !value.contains("--")
}
pub fn valid_handle(value: &str) -> bool {
    valid_slug(value, 3, 32) && !RESERVED_HANDLES.contains(&value)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageKind {
    Note,
    Canvas,
}
impl PageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Canvas => "canvas",
        }
    }
    pub fn parse(value: &str) -> Self {
        if value == "canvas" {
            Self::Canvas
        } else {
            Self::Note
        }
    }
}

/// A published page, as its owner sees it.
#[derive(Clone, Debug, Serialize)]
pub struct PublishedPage {
    pub id: Uuid,
    pub slug: String,
    pub title: String,
    pub kind: PageKind,
    /// The app's own id for what was published (a note id). Opaque here; it
    /// lets another device of the owner find the page instead of making a
    /// second one.
    pub source_id: String,
    /// SHA-256 of what the app sent, so it can tell whether there are
    /// changes left to publish without the service keeping the source.
    pub source_digest: String,
    pub site_id: Option<Uuid>,
    pub bytes: i32,
    pub published_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub taken_down: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct PublishedSite {
    pub id: Uuid,
    pub title: String,
    pub home_page_id: Option<Uuid>,
    /// In navigation order.
    pub page_ids: Vec<Uuid>,
    pub updated_at: DateTime<Utc>,
    pub taken_down: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct PublicProfile {
    pub handle: String,
    pub display_name: String,
    pub bio: String,
    pub has_avatar: bool,
    pub updated_at: DateTime<Utc>,
    pub taken_down: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListingReference {
    pub name: String,
    pub text: String,
}

/// Who published a listing, shown only when they have a public profile.
#[derive(Clone, Debug, Serialize)]
pub struct Author {
    pub handle: String,
    pub display_name: String,
}

/// An assistant definition in the public catalog, in full.
#[derive(Clone, Debug, Serialize)]
pub struct AssistantListing {
    pub id: Uuid,
    pub source_id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub instructions: String,
    pub starter: String,
    pub permissions: Vec<String>,
    pub references: Vec<ListingReference>,
    pub import_count: i64,
    pub published_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub author: Option<Author>,
    pub taken_down: bool,
}

/// One line of the catalog.
#[derive(Clone, Debug, Serialize)]
pub struct ListingSummary {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub category: String,
    pub import_count: i64,
    pub reference_count: i32,
    pub updated_at: DateTime<Utc>,
    pub author: Option<Author>,
}

/// Everything an account has made public.
#[derive(Clone, Debug, Serialize)]
pub struct Publications {
    pub publication_url: String,
    pub profile: Option<PublicProfile>,
    pub pages: Vec<PublishedPage>,
    pub sites: Vec<PublishedSite>,
    pub assistants: Vec<AssistantListing>,
}

/// What a public page needs to render: its own text and, when it belongs to a
/// site, that site's navigation.
#[derive(Clone, Debug)]
pub struct PublicPage {
    pub id: Uuid,
    pub slug: String,
    pub title: String,
    pub html: String,
    pub updated_at: DateTime<Utc>,
    pub site: Option<SiteNavigation>,
}
#[derive(Clone, Debug)]
pub struct SiteNavigation {
    pub title: String,
    pub home_slug: Option<String>,
    /// `(slug, title)` in navigation order.
    pub pages: Vec<(String, String)>,
}

/// What a public profile page lists.
#[derive(Clone, Debug)]
pub struct PublicProfileView {
    pub profile: PublicProfile,
    /// `(title, home slug)` of each site with a home page.
    pub sites: Vec<(String, String)>,
    /// `(slug, title)` of each page outside any site.
    pub pages: Vec<(String, String)>,
    /// `(id, name, description)`.
    pub assistants: Vec<(Uuid, String, String)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportTarget {
    Page,
    Profile,
    Assistant,
}
impl ReportTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Page => "page",
            Self::Profile => "profile",
            Self::Assistant => "assistant",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "page" => Some(Self::Page),
            "profile" => Some(Self::Profile),
            "assistant" => Some(Self::Assistant),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportReason {
    Spam,
    Abuse,
    Illegal,
    Privacy,
    Other,
}
impl ReportReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spam => "spam",
            Self::Abuse => "abuse",
            Self::Illegal => "illegal",
            Self::Privacy => "privacy",
            Self::Other => "other",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "spam" => Some(Self::Spam),
            "abuse" => Some(Self::Abuse),
            "illegal" => Some(Self::Illegal),
            "privacy" => Some(Self::Privacy),
            "other" => Some(Self::Other),
            _ => None,
        }
    }
}

/// An open report, as the operator's takedown tool lists it.
#[derive(Clone, Debug, Serialize)]
pub struct OpenReport {
    pub target_kind: String,
    pub target_id: Uuid,
    pub reports: i64,
    pub reasons: Vec<String>,
    pub details: Vec<String>,
    pub first_at: DateTime<Utc>,
    pub label: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slug_is_a_plain_lowercase_segment() {
        for good in ["abc", "my-notes-2026", "a1b"] {
            assert!(valid_slug(good, 3, 64), "{good}");
        }
        for bad in [
            "ab", "-abc", "abc-", "a--b", "ABC", "a b c", "a/b/c", "../etc", "ãbc", "abc.html",
        ] {
            assert!(!valid_slug(bad, 3, 64), "{bad}");
        }
    }

    #[test]
    fn a_handle_cannot_pass_for_the_operator() {
        assert!(valid_handle("morgan"));
        assert!(!valid_handle("subrosa"));
        assert!(!valid_handle("support"));
        assert!(!valid_handle(&"a".repeat(33)));
    }
}
