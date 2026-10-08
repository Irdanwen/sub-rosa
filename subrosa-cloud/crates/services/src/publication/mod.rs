//! Publishing (ADR 0097): the one place this service holds plaintext meant for
//! strangers. Shares (ADR 0053) are untouched by it: a share is a dated
//! envelope the service cannot open; a page is a public document the service
//! renders. Nothing here reads the encrypted library: whatever is public was
//! sent, in the clear, by an explicit publish.
use super::{Service, hash};
use sha2::{Digest, Sha256};
use subrosa_domain::publication::{
    AssistantListing, CATEGORIES, ListingReference, ListingSummary, OpenReport, PageKind,
    PolicyRule, PublicPage, PublicProfile, PublicProfileView, Publications, PublishedPage,
    PublishedSite, ReportReason, valid_handle, valid_slug,
};
use subrosa_domain::{Error, Result, Session};
use subrosa_persistence::{ListingWrite, PageWrite, ProfileWrite, SiteWrite};
pub use subrosa_persistence::{ReportSubject, TakedownTarget};
use uuid::Uuid;

pub mod policy;
pub mod render;
use policy::{check_text, required};

/// Publishing writes per account per minute. A person publishes, edits and
/// publishes again; a loop is a script.
const WRITES_PER_MINUTE: i32 = 30;
/// Reports per address per minute, on top of the service-wide budget.
const REPORTS_PER_MINUTE: i32 = 5;
pub const CATALOG_PAGE: i64 = 24;

pub struct PageInput {
    pub id: Uuid,
    pub slug: String,
    pub title: String,
    pub kind: PageKind,
    pub source_id: String,
    pub markdown: String,
}
pub struct SiteInput {
    pub id: Uuid,
    pub title: String,
    pub home_page_id: Option<Uuid>,
    pub page_ids: Vec<Uuid>,
}
pub struct ProfileInput {
    pub handle: String,
    pub display_name: String,
    pub bio: String,
}
pub struct ListingInput {
    pub id: Uuid,
    pub source_id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub instructions: String,
    pub starter: String,
    pub permissions: Vec<String>,
    pub references: Vec<ListingReference>,
}

/// SHA-256 of what the app sent for a page, as lowercase hex. The app
/// computes the same over the same bytes to know whether its note has changed
/// since the last publish.
pub fn page_digest(title: &str, markdown: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(title.as_bytes());
    hasher.update([0]);
    hasher.update(markdown.as_bytes());
    hex(&hasher.finalize())
}
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(64), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}
fn source_id(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(Error::ContentPolicy(PolicyRule::Shape));
    }
    Ok(value.to_string())
}
/// A permission a published assistant may ask for. The catalog carries the
/// app's tool keys only: a connector is an account of the publisher's own,
/// and a grant of it means nothing anywhere else.
fn valid_permission(key: &str) -> bool {
    matches!(
        key,
        "web" | "image" | "video" | "music" | "speech" | "documents" | "notes" | "memory"
    )
}

impl Service {
    fn publication(&self) -> Result<&subrosa_config::Publication> {
        self.config.publication.as_ref().ok_or(Error::NotFound)
    }
    pub fn publication_enabled(&self) -> bool {
        self.config.publication.is_some()
    }
    async fn publishing_budget(&self, session: &Session) -> Result<()> {
        self.repository
            .rate_limit(
                &hash(format!("publish:{}", session.account.id)),
                WRITES_PER_MINUTE,
            )
            .await
    }
    fn policy(&self, fields: &[&str]) -> Result<()> {
        let blocked = self
            .config
            .publication
            .as_ref()
            .map_or(&[][..], |p| p.blocked_terms.as_slice());
        check_text(fields, blocked).map_err(Error::ContentPolicy)
    }

    pub async fn publications(&self, session: &Session) -> Result<Publications> {
        let publication = self.publication()?;
        let (profile, pages, sites, assistants) =
            self.repository.publications(session.account.id).await?;
        Ok(Publications {
            publication_url: publication.url.clone(),
            profile,
            pages,
            sites,
            assistants,
        })
    }

    /// Renders and stores a page. The rules run over the source; the size cap
    /// runs again over the rendered HTML, which is what is actually stored.
    pub async fn publish_page(&self, session: &Session, p: PageInput) -> Result<PublishedPage> {
        self.publication()?;
        if !valid_slug(&p.slug, 3, 64) {
            return Err(Error::ContentPolicy(PolicyRule::Shape));
        }
        let title = required(&p.title, policy::MAX_TITLE_CHARS).map_err(Error::ContentPolicy)?;
        if p.markdown.trim().is_empty() {
            return Err(Error::ContentPolicy(PolicyRule::Empty));
        }
        if p.markdown.len() > policy::MAX_PAGE_SOURCE_BYTES {
            return Err(Error::ContentPolicy(PolicyRule::TooLarge));
        }
        self.policy(&[&title, &p.markdown])?;
        let html = render::markdown_to_html(&p.markdown);
        if html.len() > policy::MAX_PAGE_HTML_BYTES {
            return Err(Error::ContentPolicy(PolicyRule::TooLarge));
        }
        let source_id = source_id(&p.source_id)?;
        self.publishing_budget(session).await?;
        self.repository
            .publish_page(PageWrite {
                owner: session.account.id,
                id: p.id,
                slug: &p.slug,
                title: &title,
                kind: p.kind,
                source_id: &source_id,
                source_digest: &page_digest(&p.title, &p.markdown),
                html: &html,
                max_pages: policy::MAX_PAGES,
                suspension: policy::SUSPENSION_TAKEDOWNS,
            })
            .await
    }
    pub async fn unpublish_page(&self, session: &Session, id: Uuid) -> Result<()> {
        self.publication()?;
        self.repository.unpublish_page(session.account.id, id).await
    }
    pub async fn save_site(&self, session: &Session, p: SiteInput) -> Result<PublishedSite> {
        self.publication()?;
        let title = required(&p.title, policy::MAX_TITLE_CHARS).map_err(Error::ContentPolicy)?;
        self.policy(&[&title])?;
        let mut seen = std::collections::HashSet::new();
        if p.page_ids.is_empty()
            || p.page_ids.len() > policy::MAX_SITE_PAGES
            || !p.page_ids.iter().all(|id| seen.insert(*id))
            || p.home_page_id.is_some_and(|home| !seen.contains(&home))
        {
            return Err(Error::ContentPolicy(PolicyRule::Shape));
        }
        self.publishing_budget(session).await?;
        self.repository
            .save_site(SiteWrite {
                owner: session.account.id,
                id: p.id,
                title: &title,
                home_page_id: p.home_page_id.or_else(|| p.page_ids.first().copied()),
                page_ids: &p.page_ids,
                max_sites: policy::MAX_SITES,
            })
            .await
    }
    pub async fn delete_site(&self, session: &Session, id: Uuid) -> Result<()> {
        self.publication()?;
        self.repository.delete_site(session.account.id, id).await
    }

    pub async fn save_profile(&self, session: &Session, p: ProfileInput) -> Result<PublicProfile> {
        self.publication()?;
        let handle = p.handle.trim().to_ascii_lowercase();
        if !valid_handle(&handle) {
            return Err(Error::ContentPolicy(PolicyRule::Shape));
        }
        let display_name = required(&p.display_name, policy::MAX_DISPLAY_NAME_CHARS)
            .map_err(Error::ContentPolicy)?;
        let bio = p.bio.trim();
        if bio.chars().count() > policy::MAX_BIO_CHARS {
            return Err(Error::ContentPolicy(PolicyRule::TooLarge));
        }
        self.policy(&[&handle, &display_name, bio])?;
        self.publishing_budget(session).await?;
        self.repository
            .save_profile(ProfileWrite {
                owner: session.account.id,
                handle: &handle,
                display_name: &display_name,
                bio,
                suspension: policy::SUSPENSION_TAKEDOWNS,
            })
            .await
    }
    /// Sets the avatar from raw bytes, or clears it with `None`. The type is
    /// read from the bytes; what the upload claims is ignored.
    pub async fn set_avatar(&self, session: &Session, bytes: Option<&[u8]>) -> Result<()> {
        self.publication()?;
        let avatar = match bytes {
            Some(bytes) => {
                if bytes.len() > policy::MAX_AVATAR_BYTES {
                    return Err(Error::ContentPolicy(PolicyRule::TooLarge));
                }
                let kind =
                    policy::avatar_type(bytes).ok_or(Error::ContentPolicy(PolicyRule::Shape))?;
                Some((bytes, kind))
            }
            None => None,
        };
        self.publishing_budget(session).await?;
        self.repository.set_avatar(session.account.id, avatar).await
    }
    pub async fn delete_profile(&self, session: &Session) -> Result<()> {
        self.publication()?;
        self.repository.delete_profile(session.account.id).await
    }

    pub async fn publish_listing(
        &self,
        session: &Session,
        p: ListingInput,
    ) -> Result<AssistantListing> {
        self.publication()?;
        let name = required(&p.name, policy::MAX_NAME_CHARS).map_err(Error::ContentPolicy)?;
        let description = required(&p.description, policy::MAX_DESCRIPTION_CHARS)
            .map_err(Error::ContentPolicy)?;
        if !CATEGORIES.contains(&p.category.as_str()) {
            return Err(Error::ContentPolicy(PolicyRule::Shape));
        }
        if p.instructions.trim().is_empty() {
            return Err(Error::ContentPolicy(PolicyRule::Empty));
        }
        let reference_bytes: usize = p
            .references
            .iter()
            .map(|r| r.name.len() + r.text.len())
            .sum();
        if p.instructions.len() > policy::MAX_INSTRUCTIONS_BYTES
            || p.starter.len() > policy::MAX_STARTER_BYTES
            || p.references.len() > policy::MAX_REFERENCES
            || reference_bytes > policy::MAX_REFERENCES_BYTES
            || p.references
                .iter()
                .any(|r| r.name.chars().count() > policy::MAX_TITLE_CHARS)
        {
            return Err(Error::ContentPolicy(PolicyRule::TooLarge));
        }
        let mut permissions = p.permissions.clone();
        permissions.sort();
        permissions.dedup();
        if permissions.len() > policy::MAX_PERMISSIONS
            || !permissions.iter().all(|key| valid_permission(key))
        {
            return Err(Error::ContentPolicy(PolicyRule::Shape));
        }
        let references: Vec<ListingReference> = p
            .references
            .iter()
            .map(|r| ListingReference {
                name: r.name.trim().to_string(),
                text: r.text.clone(),
            })
            .collect();
        let mut fields = vec![
            name.as_str(),
            description.as_str(),
            p.instructions.as_str(),
            p.starter.as_str(),
        ];
        for reference in &references {
            if reference.name.is_empty() || reference.text.trim().is_empty() {
                return Err(Error::ContentPolicy(PolicyRule::Empty));
            }
            fields.push(&reference.name);
            fields.push(&reference.text);
        }
        self.policy(&fields)?;
        let source_id = source_id(&p.source_id)?;
        let bytes = i32::try_from(
            name.len()
                + description.len()
                + p.instructions.len()
                + p.starter.len()
                + reference_bytes,
        )
        .map_err(|_| Error::Invalid)?;
        self.publishing_budget(session).await?;
        self.repository
            .publish_listing(ListingWrite {
                owner: session.account.id,
                id: p.id,
                source_id: &source_id,
                name: &name,
                description: &description,
                category: &p.category,
                instructions: &p.instructions,
                instructions_digest: &hex(&Sha256::digest(p.instructions.as_bytes())),
                starter: &p.starter,
                permissions: &permissions,
                references: &references,
                bytes,
                max_listings: policy::MAX_LISTINGS,
                suspension: policy::SUSPENSION_TAKEDOWNS,
            })
            .await
    }
    pub async fn unpublish_listing(&self, session: &Session, id: Uuid) -> Result<()> {
        self.publication()?;
        self.repository
            .unpublish_listing(session.account.id, id)
            .await
    }

    /// One page of the catalog: a search over names and descriptions, a
    /// category, or both.
    pub async fn catalog(
        &self,
        query: Option<&str>,
        category: Option<&str>,
        page: i64,
    ) -> Result<Vec<ListingSummary>> {
        self.publication()?;
        let query = query.map(str::trim).filter(|q| !q.is_empty());
        if query.is_some_and(|q| q.chars().count() > 100)
            || category.is_some_and(|c| !CATEGORIES.contains(&c))
            || !(0..=100).contains(&page)
        {
            return Err(Error::Invalid);
        }
        self.repository
            .catalog(query, category, page * CATALOG_PAGE, CATALOG_PAGE)
            .await
    }
    pub async fn listing(&self, id: Uuid, imported: bool) -> Result<AssistantListing> {
        self.publication()?;
        let mut listing = self.repository.listing(id, imported).await?;
        // The publisher's own id for the assistant means nothing to a reader.
        listing.source_id.clear();
        Ok(listing)
    }

    /// The page at `slug`, for the public origin only.
    pub async fn public_page(&self, slug: &str) -> Result<PublicPage> {
        self.publication()?;
        if !valid_slug(slug, 3, 64) {
            return Err(Error::NotFound);
        }
        self.repository.public_page(slug).await
    }
    pub async fn public_profile(&self, handle: &str) -> Result<PublicProfileView> {
        self.publication()?;
        if !valid_slug(handle, 3, 32) {
            return Err(Error::NotFound);
        }
        self.repository.public_profile(handle).await
    }
    pub async fn avatar(&self, handle: &str) -> Result<(Vec<u8>, String)> {
        self.publication()?;
        if !valid_slug(handle, 3, 32) {
            return Err(Error::NotFound);
        }
        self.repository.avatar(handle).await
    }

    /// Records a report from `client` (an address, hashed before it is kept).
    pub async fn report(
        &self,
        subject: ReportSubject<'_>,
        reason: ReportReason,
        detail: &str,
        client: &str,
    ) -> Result<()> {
        self.publication()?;
        let detail = detail.trim();
        if detail.chars().count() > policy::MAX_REPORT_DETAIL_CHARS
            || detail
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            return Err(Error::Invalid);
        }
        self.repository
            .rate_limit(&hash(format!("{client}:report")), REPORTS_PER_MINUTE)
            .await?;
        let reporter = hash(format!("subrosa-report-v1:{client}"));
        self.repository
            .report(subject, reason, detail, &reporter)
            .await
    }

    /// The operator's tool (`subrosa-cloud takedown`), never an HTTP route.
    pub async fn take_down(&self, target: TakedownTarget<'_>, reason: &str) -> Result<()> {
        let reason = reason.trim();
        if reason.is_empty() || reason.chars().count() > 500 {
            return Err(Error::Invalid);
        }
        self.repository.take_down(target, reason).await
    }
    pub async fn open_reports(&self) -> Result<Vec<OpenReport>> {
        self.repository.open_reports().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The app hashes the same bytes to know whether a note changed since it
    /// was published: the title, a zero byte, the body.
    #[test]
    fn the_page_digest_is_stable_and_separates_title_from_body() {
        assert_eq!(
            page_digest("Title", "Body"),
            "00f2f2dac8eaaabb92ee3fb6da5c27d99eddd4e9cc6761a924b7f63790e9a619"
        );
        assert_ne!(page_digest("Ti", "tleBody"), page_digest("Title", "Body"));
        assert_eq!(page_digest("a", "b").len(), 64);
    }

    #[test]
    fn a_listing_carries_tool_keys_and_never_a_connector() {
        assert!(valid_permission("web"));
        assert!(valid_permission("notes"));
        assert!(!valid_permission("connector:gmail-x1"));
        assert!(!valid_permission("terminal"));
    }

    #[test]
    fn a_source_id_is_an_opaque_token() {
        assert!(source_id("7f3e2b0c-1a2b-4c3d-8e9f-0a1b2c3d4e5f").is_ok());
        assert!(source_id("../notes").is_err());
        assert!(source_id("").is_err());
        assert!(source_id(&"a".repeat(65)).is_err());
    }
}
