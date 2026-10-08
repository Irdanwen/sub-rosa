//! Public content (ADR 0097): pages, sites, profiles, catalog listings,
//! reports and takedowns. Every write locks the account row, like the rest of
//! the account's state, and checks the takedown history in the same
//! transaction, so a takedown cannot race a republish.
use super::{Repository, db, lock_account};
use chrono::{DateTime, Utc};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow, types::Json};
use subrosa_domain::publication::{
    AssistantListing, Author, ListingReference, ListingSummary, OpenReport, PageKind, PolicyRule,
    PublicPage, PublicProfile, PublicProfileView, PublishedPage, PublishedSite, ReportReason,
    SiteNavigation,
};
use subrosa_domain::{Error, Result};
use uuid::Uuid;

pub struct PageWrite<'a> {
    pub owner: Uuid,
    pub id: Uuid,
    pub slug: &'a str,
    pub title: &'a str,
    pub kind: PageKind,
    pub source_id: &'a str,
    pub source_digest: &'a str,
    pub html: &'a str,
    pub max_pages: i64,
    pub suspension: i64,
}
pub struct SiteWrite<'a> {
    pub owner: Uuid,
    pub id: Uuid,
    pub title: &'a str,
    pub home_page_id: Option<Uuid>,
    pub page_ids: &'a [Uuid],
    pub max_sites: i64,
}
pub struct ProfileWrite<'a> {
    pub owner: Uuid,
    pub handle: &'a str,
    pub display_name: &'a str,
    pub bio: &'a str,
    pub suspension: i64,
}
pub struct ListingWrite<'a> {
    pub owner: Uuid,
    pub id: Uuid,
    pub source_id: &'a str,
    pub name: &'a str,
    pub description: &'a str,
    pub category: &'a str,
    pub instructions: &'a str,
    pub instructions_digest: &'a str,
    pub starter: &'a str,
    pub permissions: &'a [String],
    pub references: &'a [ListingReference],
    pub bytes: i32,
    pub max_listings: i64,
    pub suspension: i64,
}
/// What a report names, as the reader's page knows it.
pub enum ReportSubject<'a> {
    PageSlug(&'a str),
    Handle(&'a str),
    Assistant(Uuid),
}
/// What a takedown names, as the operator's tool knows it.
#[derive(Clone, Copy, Debug)]
pub enum TakedownTarget<'a> {
    Page(&'a str),
    Site(Uuid),
    Profile(&'a str),
    Assistant(Uuid),
}

const PAGE_COLUMNS: &str = "id,slug,title,kind,source_id,source_digest,site_id,bytes,published_at,updated_at,taken_down_at";
const LISTING_COLUMNS: &str = "l.id,l.source_id,l.name,l.description,l.category,l.instructions,l.starter,l.permissions,l.refs,l.import_count,l.published_at,l.updated_at,l.taken_down_at,p.handle,p.display_name";
const LISTING_FROM: &str = "assistant_listings l LEFT JOIN public_profiles p ON p.account_id=l.account_id AND p.taken_down_at IS NULL";

fn page_row(r: &PgRow) -> PublishedPage {
    PublishedPage {
        id: r.get("id"),
        slug: r.get("slug"),
        title: r.get("title"),
        kind: PageKind::parse(r.get("kind")),
        source_id: r.get("source_id"),
        source_digest: r.get("source_digest"),
        site_id: r.get("site_id"),
        bytes: r.get("bytes"),
        published_at: r.get("published_at"),
        updated_at: r.get("updated_at"),
        taken_down: r.get::<Option<DateTime<Utc>>, _>("taken_down_at").is_some(),
    }
}
fn author(r: &PgRow) -> Option<Author> {
    Some(Author {
        handle: r.get::<Option<String>, _>("handle")?,
        display_name: r.get::<Option<String>, _>("display_name")?,
    })
}
fn listing_row(r: &PgRow) -> AssistantListing {
    AssistantListing {
        id: r.get("id"),
        source_id: r.get("source_id"),
        name: r.get("name"),
        description: r.get("description"),
        category: r.get("category"),
        instructions: r.get("instructions"),
        starter: r.get("starter"),
        permissions: r.get::<Json<Vec<String>>, _>("permissions").0,
        references: r.get::<Json<Vec<ListingReference>>, _>("refs").0,
        import_count: r.get("import_count"),
        published_at: r.get("published_at"),
        updated_at: r.get("updated_at"),
        author: author(r),
        taken_down: r.get::<Option<DateTime<Utc>>, _>("taken_down_at").is_some(),
    }
}
fn profile_row(r: &PgRow) -> PublicProfile {
    PublicProfile {
        handle: r.get("handle"),
        display_name: r.get("display_name"),
        bio: r.get("bio"),
        has_avatar: r.get("has_avatar"),
        updated_at: r.get("updated_at"),
        taken_down: r.get::<Option<DateTime<Utc>>, _>("taken_down_at").is_some(),
    }
}
/// A unique index on a public address said no: somebody else has it.
fn unique_violation(error: &sqlx::Error, constraint: &str) -> bool {
    error
        .as_database_error()
        .is_some_and(|e| e.code().as_deref() == Some("23505") && e.constraint() == Some(constraint))
}
/// Refuses an account past the takedown threshold, and content identical to
/// something taken down.
async fn allowed(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    digest: Option<&str>,
    suspension: i64,
) -> Result<()> {
    let strikes: i64 = sqlx::query_scalar("SELECT count(*) FROM takedowns WHERE account_id=$1")
        .bind(owner)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
    if strikes >= suspension {
        return Err(Error::PublishingSuspended);
    }
    if let Some(digest) = digest {
        let copied: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM takedowns WHERE content_digest=$1)")
                .bind(digest)
                .fetch_one(&mut **tx)
                .await
                .map_err(db)?;
        if copied {
            return Err(Error::TakenDown);
        }
    }
    Ok(())
}
/// A row's owner and takedown state, for a write that names it by id.
async fn owned(
    tx: &mut Transaction<'_, Postgres>,
    table: &str,
    owner: Uuid,
    id: Uuid,
) -> Result<bool> {
    let row = sqlx::query(&format!(
        "SELECT account_id,taken_down_at FROM {table} WHERE id=$1 FOR UPDATE"
    ))
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?;
    let Some(row) = row else {
        return Ok(false);
    };
    // Another account's id is answered as if it did not exist, and a write
    // to it as a conflict: ids are client generated, so a collision is a
    // client bug, never a way to reach somebody else's row.
    if row.get::<Uuid, _>("account_id") != owner {
        return Err(Error::Conflict);
    }
    if row
        .get::<Option<DateTime<Utc>>, _>("taken_down_at")
        .is_some()
    {
        return Err(Error::TakenDown);
    }
    Ok(true)
}

impl Repository {
    /// Everything `owner` has made public, taken down or not.
    pub async fn publications(
        &self,
        owner: Uuid,
    ) -> Result<(
        Option<PublicProfile>,
        Vec<PublishedPage>,
        Vec<PublishedSite>,
        Vec<AssistantListing>,
    )> {
        let profile = sqlx::query("SELECT handle,display_name,bio,avatar IS NOT NULL AS has_avatar,updated_at,taken_down_at FROM public_profiles WHERE account_id=$1")
            .bind(owner)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .as_ref()
            .map(profile_row);
        let pages = sqlx::query(&format!("SELECT {PAGE_COLUMNS} FROM published_pages WHERE account_id=$1 ORDER BY updated_at DESC"))
            .bind(owner)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?
            .iter()
            .map(page_row)
            .collect();
        let sites = sqlx::query("SELECT s.id,s.title,s.home_page_id,s.updated_at,s.taken_down_at,COALESCE(array_agg(p.id ORDER BY p.position,p.published_at) FILTER (WHERE p.id IS NOT NULL),'{}') AS page_ids FROM published_sites s LEFT JOIN published_pages p ON p.site_id=s.id WHERE s.account_id=$1 GROUP BY s.id ORDER BY s.updated_at DESC")
            .bind(owner)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?
            .iter()
            .map(|r| PublishedSite {
                id: r.get("id"),
                title: r.get("title"),
                home_page_id: r.get("home_page_id"),
                page_ids: r.get("page_ids"),
                updated_at: r.get("updated_at"),
                taken_down: r.get::<Option<DateTime<Utc>>, _>("taken_down_at").is_some(),
            })
            .collect();
        let listings = sqlx::query(&format!(
            "SELECT {LISTING_COLUMNS} FROM {LISTING_FROM} WHERE l.account_id=$1 ORDER BY l.updated_at DESC"
        ))
        .bind(owner)
        .fetch_all(&self.pool)
        .await
        .map_err(db)?
        .iter()
        .map(listing_row)
        .collect();
        Ok((profile, pages, sites, listings))
    }

    /// Publishes a page, or replaces what an earlier publish of it showed.
    pub async fn publish_page(&self, p: PageWrite<'_>) -> Result<PublishedPage> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, p.owner).await?;
        allowed(&mut tx, p.owner, Some(p.source_digest), p.suspension).await?;
        let exists = owned(&mut tx, "published_pages", p.owner, p.id).await?;
        // One page per source on an account: a second device publishing the
        // same note must update the first page, not open another.
        let other: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM published_pages WHERE account_id=$1 AND source_id=$2 AND id<>$3",
        )
        .bind(p.owner)
        .bind(p.source_id)
        .bind(p.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if other.is_some() {
            return Err(Error::Conflict);
        }
        if !exists {
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM published_pages WHERE account_id=$1")
                    .bind(p.owner)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(db)?;
            if count >= p.max_pages {
                return Err(Error::ContentPolicy(PolicyRule::TooMany));
            }
        }
        let bytes = i32::try_from(p.html.len()).map_err(|_| Error::Invalid)?;
        let row = sqlx::query(&format!("INSERT INTO published_pages(id,account_id,slug,title,kind,source_id,source_digest,html,bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,title=excluded.title,kind=excluded.kind,source_digest=excluded.source_digest,html=excluded.html,bytes=excluded.bytes,updated_at=now() RETURNING {PAGE_COLUMNS}"))
            .bind(p.id)
            .bind(p.owner)
            .bind(p.slug)
            .bind(p.title)
            .bind(p.kind.as_str())
            .bind(p.source_id)
            .bind(p.source_digest)
            .bind(p.html)
            .bind(bytes)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| {
                if unique_violation(&e, "published_pages_slug_key") {
                    Error::SlugTaken
                } else {
                    db(e)
                }
            })?;
        tx.commit().await.map_err(db)?;
        Ok(page_row(&row))
    }
    /// Removes a page. What it showed is gone from the service at once; a
    /// copy a reader saved is not, and the app says so.
    pub async fn unpublish_page(&self, owner: Uuid, id: Uuid) -> Result<()> {
        let removed = sqlx::query("DELETE FROM published_pages WHERE id=$1 AND account_id=$2")
            .bind(id)
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?
            .rows_affected();
        if removed == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    /// Sets a site's title, home page and pages, in navigation order. Pages
    /// that left the site stay published, on their own.
    pub async fn save_site(&self, p: SiteWrite<'_>) -> Result<PublishedSite> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, p.owner).await?;
        let exists = owned(&mut tx, "published_sites", p.owner, p.id).await?;
        if !exists {
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM published_sites WHERE account_id=$1")
                    .bind(p.owner)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(db)?;
            if count >= p.max_sites {
                return Err(Error::ContentPolicy(PolicyRule::TooMany));
            }
        }
        let mine: i64 = sqlx::query_scalar("SELECT count(*) FROM published_pages WHERE account_id=$1 AND id=ANY($2::uuid[]) AND taken_down_at IS NULL")
            .bind(p.owner)
            .bind(p.page_ids)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if mine != i64::try_from(p.page_ids.len()).unwrap_or(i64::MAX) {
            return Err(Error::NotFound);
        }
        let row = sqlx::query("INSERT INTO published_sites(id,account_id,title,home_page_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET title=excluded.title,home_page_id=excluded.home_page_id,updated_at=now() RETURNING updated_at")
            .bind(p.id)
            .bind(p.owner)
            .bind(p.title)
            .bind(p.home_page_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE published_pages SET site_id=NULL,position=0 WHERE site_id=$1")
            .bind(p.id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        for (position, page) in p.page_ids.iter().enumerate() {
            sqlx::query("UPDATE published_pages SET site_id=$1,position=$2 WHERE id=$3")
                .bind(p.id)
                .bind(i32::try_from(position).map_err(|_| Error::Invalid)?)
                .bind(page)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(PublishedSite {
            id: p.id,
            title: p.title.to_string(),
            home_page_id: p.home_page_id,
            page_ids: p.page_ids.to_vec(),
            updated_at: row.get("updated_at"),
            taken_down: false,
        })
    }
    /// Removes the site; its pages stay published on their own.
    pub async fn delete_site(&self, owner: Uuid, id: Uuid) -> Result<()> {
        let removed = sqlx::query("DELETE FROM published_sites WHERE id=$1 AND account_id=$2")
            .bind(id)
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?
            .rows_affected();
        if removed == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    pub async fn save_profile(&self, p: ProfileWrite<'_>) -> Result<PublicProfile> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, p.owner).await?;
        let handle_digest = handle_digest(p.handle);
        allowed(&mut tx, p.owner, Some(&handle_digest), p.suspension).await?;
        let down: Option<Option<DateTime<Utc>>> = sqlx::query_scalar(
            "SELECT taken_down_at FROM public_profiles WHERE account_id=$1 FOR UPDATE",
        )
        .bind(p.owner)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if down.flatten().is_some() {
            return Err(Error::TakenDown);
        }
        let row = sqlx::query("INSERT INTO public_profiles(account_id,handle,display_name,bio) VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET handle=excluded.handle,display_name=excluded.display_name,bio=excluded.bio,updated_at=now() RETURNING handle,display_name,bio,avatar IS NOT NULL AS has_avatar,updated_at,taken_down_at")
            .bind(p.owner)
            .bind(p.handle)
            .bind(p.display_name)
            .bind(p.bio)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| {
                if unique_violation(&e, "public_profiles_handle_key") {
                    Error::SlugTaken
                } else {
                    db(e)
                }
            })?;
        tx.commit().await.map_err(db)?;
        Ok(profile_row(&row))
    }
    /// Sets or clears the avatar. The caller has already identified the bytes.
    pub async fn set_avatar(&self, owner: Uuid, avatar: Option<(&[u8], &str)>) -> Result<()> {
        let updated = sqlx::query("UPDATE public_profiles SET avatar=$2,avatar_type=$3,updated_at=now() WHERE account_id=$1 AND taken_down_at IS NULL")
            .bind(owner)
            .bind(avatar.map(|(bytes, _)| bytes))
            .bind(avatar.map(|(_, kind)| kind))
            .execute(&self.pool)
            .await
            .map_err(db)?
            .rows_affected();
        if updated == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }
    pub async fn delete_profile(&self, owner: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM public_profiles WHERE account_id=$1")
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }

    pub async fn publish_listing(&self, p: ListingWrite<'_>) -> Result<AssistantListing> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, p.owner).await?;
        allowed(&mut tx, p.owner, Some(p.instructions_digest), p.suspension).await?;
        let exists = owned(&mut tx, "assistant_listings", p.owner, p.id).await?;
        let other: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM assistant_listings WHERE account_id=$1 AND source_id=$2 AND id<>$3",
        )
        .bind(p.owner)
        .bind(p.source_id)
        .bind(p.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if other.is_some() {
            return Err(Error::Conflict);
        }
        if !exists {
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM assistant_listings WHERE account_id=$1")
                    .bind(p.owner)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(db)?;
            if count >= p.max_listings {
                return Err(Error::ContentPolicy(PolicyRule::TooMany));
            }
        }
        sqlx::query("INSERT INTO assistant_listings(id,account_id,source_id,name,description,category,instructions,starter,permissions,refs,bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,category=excluded.category,instructions=excluded.instructions,starter=excluded.starter,permissions=excluded.permissions,refs=excluded.refs,bytes=excluded.bytes,updated_at=now()")
            .bind(p.id)
            .bind(p.owner)
            .bind(p.source_id)
            .bind(p.name)
            .bind(p.description)
            .bind(p.category)
            .bind(p.instructions)
            .bind(p.starter)
            .bind(Json(p.permissions))
            .bind(Json(p.references))
            .bind(p.bytes)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let row = sqlx::query(&format!(
            "SELECT {LISTING_COLUMNS} FROM {LISTING_FROM} WHERE l.id=$1"
        ))
        .bind(p.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(listing_row(&row))
    }
    pub async fn unpublish_listing(&self, owner: Uuid, id: Uuid) -> Result<()> {
        let removed = sqlx::query("DELETE FROM assistant_listings WHERE id=$1 AND account_id=$2")
            .bind(id)
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?
            .rows_affected();
        if removed == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    /// One page of the catalog. `query` matches the name or the description,
    /// as plain text: its `%`, `_` and `\` are escaped, never wildcards.
    pub async fn catalog(
        &self,
        query: Option<&str>,
        category: Option<&str>,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<ListingSummary>> {
        let pattern = query.map(|q| {
            format!(
                "%{}%",
                q.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        });
        Ok(sqlx::query(&format!("SELECT l.id,l.name,l.description,l.category,l.import_count,jsonb_array_length(l.refs) AS reference_count,l.updated_at,p.handle,p.display_name FROM {LISTING_FROM} WHERE l.taken_down_at IS NULL AND ($1::text IS NULL OR l.name ILIKE $1 OR l.description ILIKE $1) AND ($2::text IS NULL OR l.category=$2) ORDER BY l.import_count DESC,l.updated_at DESC,l.id LIMIT $3 OFFSET $4"))
            .bind(pattern)
            .bind(category)
            .bind(limit)
            .bind(offset)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?
            .iter()
            .map(|r| ListingSummary {
                id: r.get("id"),
                name: r.get("name"),
                description: r.get("description"),
                category: r.get("category"),
                import_count: r.get("import_count"),
                reference_count: r.get("reference_count"),
                updated_at: r.get("updated_at"),
                author: author(r),
            })
            .collect())
    }
    /// A live listing in full. `imported` counts one more import: the only
    /// figure the catalog keeps about a listing's readers.
    pub async fn listing(&self, id: Uuid, imported: bool) -> Result<AssistantListing> {
        if imported {
            sqlx::query("UPDATE assistant_listings SET import_count=import_count+1 WHERE id=$1 AND taken_down_at IS NULL")
                .bind(id)
                .execute(&self.pool)
                .await
                .map_err(db)?;
        }
        let row = sqlx::query(&format!(
            "SELECT {LISTING_COLUMNS} FROM {LISTING_FROM} WHERE l.id=$1 AND l.taken_down_at IS NULL"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?
        .ok_or(Error::NotFound)?;
        Ok(listing_row(&row))
    }

    /// A live page and, when it belongs to a live site, that site's live pages.
    pub async fn public_page(&self, slug: &str) -> Result<PublicPage> {
        let row = sqlx::query("SELECT p.id,p.slug,p.title,p.html,p.updated_at,p.site_id,s.title AS site_title,h.slug AS home_slug FROM published_pages p LEFT JOIN published_sites s ON s.id=p.site_id AND s.taken_down_at IS NULL LEFT JOIN published_pages h ON h.id=s.home_page_id AND h.taken_down_at IS NULL WHERE p.slug=$1 AND p.taken_down_at IS NULL")
            .bind(slug)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .ok_or(Error::NotFound)?;
        let site = match row.get::<Option<String>, _>("site_title") {
            Some(title) => {
                let pages = sqlx::query("SELECT slug,title FROM published_pages WHERE site_id=$1 AND taken_down_at IS NULL ORDER BY position,published_at")
                    .bind(row.get::<Option<Uuid>, _>("site_id"))
                    .fetch_all(&self.pool)
                    .await
                    .map_err(db)?
                    .iter()
                    .map(|r| (r.get("slug"), r.get("title")))
                    .collect();
                Some(SiteNavigation {
                    title,
                    home_slug: row.get("home_slug"),
                    pages,
                })
            }
            None => None,
        };
        Ok(PublicPage {
            id: row.get("id"),
            slug: row.get("slug"),
            title: row.get("title"),
            html: row.get("html"),
            updated_at: row.get("updated_at"),
            site,
        })
    }
    /// A live profile and what it lists: sites with a home page, pages that
    /// belong to no site, and catalog listings.
    pub async fn public_profile(&self, handle: &str) -> Result<PublicProfileView> {
        let row = sqlx::query("SELECT account_id,handle,display_name,bio,avatar IS NOT NULL AS has_avatar,updated_at,taken_down_at FROM public_profiles WHERE handle=$1 AND taken_down_at IS NULL")
            .bind(handle)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .ok_or(Error::NotFound)?;
        let owner: Uuid = row.get("account_id");
        let sites = sqlx::query("SELECT s.title,h.slug FROM published_sites s JOIN published_pages h ON h.id=s.home_page_id AND h.taken_down_at IS NULL WHERE s.account_id=$1 AND s.taken_down_at IS NULL ORDER BY s.updated_at DESC")
            .bind(owner)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?
            .iter()
            .map(|r| (r.get("title"), r.get("slug")))
            .collect();
        let pages = sqlx::query("SELECT slug,title FROM published_pages WHERE account_id=$1 AND site_id IS NULL AND taken_down_at IS NULL ORDER BY updated_at DESC LIMIT 200")
            .bind(owner)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?
            .iter()
            .map(|r| (r.get("slug"), r.get("title")))
            .collect();
        let assistants = sqlx::query("SELECT id,name,description FROM assistant_listings WHERE account_id=$1 AND taken_down_at IS NULL ORDER BY updated_at DESC")
            .bind(owner)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?
            .iter()
            .map(|r| (r.get("id"), r.get("name"), r.get("description")))
            .collect();
        Ok(PublicProfileView {
            profile: profile_row(&row),
            sites,
            pages,
            assistants,
        })
    }
    pub async fn avatar(&self, handle: &str) -> Result<(Vec<u8>, String)> {
        let row = sqlx::query("SELECT avatar,avatar_type FROM public_profiles WHERE handle=$1 AND taken_down_at IS NULL AND avatar IS NOT NULL")
            .bind(handle)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .ok_or(Error::NotFound)?;
        Ok((row.get("avatar"), row.get("avatar_type")))
    }

    /// Records a report against live public content. One per address and
    /// target; a repeat is accepted and changes nothing.
    pub async fn report(
        &self,
        subject: ReportSubject<'_>,
        reason: ReportReason,
        detail: &str,
        reporter: &[u8],
    ) -> Result<()> {
        let (kind, target): (&str, Option<Uuid>) = match subject {
            ReportSubject::PageSlug(slug) => (
                "page",
                sqlx::query_scalar(
                    "SELECT id FROM published_pages WHERE slug=$1 AND taken_down_at IS NULL",
                )
                .bind(slug)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?,
            ),
            ReportSubject::Handle(handle) => (
                "profile",
                sqlx::query_scalar(
                    "SELECT account_id FROM public_profiles WHERE handle=$1 AND taken_down_at IS NULL",
                )
                .bind(handle)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?,
            ),
            ReportSubject::Assistant(id) => (
                "assistant",
                sqlx::query_scalar(
                    "SELECT id FROM assistant_listings WHERE id=$1 AND taken_down_at IS NULL",
                )
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?,
            ),
        };
        let target = target.ok_or(Error::NotFound)?;
        sqlx::query("INSERT INTO content_reports(id,target_kind,target_id,reason,detail,reporter_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING")
            .bind(Uuid::now_v7())
            .bind(kind)
            .bind(target)
            .bind(reason.as_str())
            .bind(detail)
            .bind(reporter)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }
    /// Open reports grouped by target, oldest first, for the operator.
    pub async fn open_reports(&self) -> Result<Vec<OpenReport>> {
        Ok(sqlx::query("SELECT r.target_kind,r.target_id,count(*) AS reports,array_agg(DISTINCT r.reason) AS reasons,array_remove(array_agg(NULLIF(r.detail,'')),NULL) AS details,min(r.created_at) AS first_at,COALESCE(p.slug||' ('||p.title||')',pr.handle,l.name,'(gone)') AS label FROM content_reports r LEFT JOIN published_pages p ON r.target_kind='page' AND p.id=r.target_id LEFT JOIN public_profiles pr ON r.target_kind='profile' AND pr.account_id=r.target_id LEFT JOIN assistant_listings l ON r.target_kind='assistant' AND l.id=r.target_id WHERE r.resolved_at IS NULL GROUP BY r.target_kind,r.target_id,p.slug,p.title,pr.handle,l.name ORDER BY first_at")
            .fetch_all(&self.pool)
            .await
            .map_err(db)?
            .iter()
            .map(|r| OpenReport {
                target_kind: r.get("target_kind"),
                target_id: r.get("target_id"),
                reports: r.get("reports"),
                reasons: r.get("reasons"),
                details: r.get("details"),
                first_at: r.get("first_at"),
                label: r.get("label"),
            })
            .collect())
    }
    /// Closes every open report on a target, without taking it down.
    pub async fn dismiss_reports(&self, kind: &str, target: Uuid) -> Result<u64> {
        Ok(sqlx::query("UPDATE content_reports SET resolved_at=now() WHERE target_kind=$1 AND target_id=$2 AND resolved_at IS NULL")
            .bind(kind)
            .bind(target)
            .execute(&self.pool)
            .await
            .map_err(db)?
            .rows_affected())
    }
    /// Takes content down: hidden at once, recorded against its owner, and its
    /// digest refused from then on. Reports on it are closed.
    pub async fn take_down(&self, target: TakedownTarget<'_>, reason: &str) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        // (account, kind, id, digest) of everything this takedown hides.
        let hidden: Vec<(Option<Uuid>, &str, Uuid, Option<String>)> = match target {
            TakedownTarget::Page(slug) => sqlx::query("UPDATE published_pages SET taken_down_at=now() WHERE slug=$1 AND taken_down_at IS NULL RETURNING account_id,id,source_digest")
                .bind(slug)
                .fetch_all(&mut *tx)
                .await
                .map_err(db)?
                .iter()
                .map(|r| (Some(r.get("account_id")), "page", r.get("id"), Some(r.get("source_digest"))))
                .collect(),
            TakedownTarget::Site(id) => {
                let mut rows: Vec<_> = sqlx::query("UPDATE published_sites SET taken_down_at=now() WHERE id=$1 AND taken_down_at IS NULL RETURNING account_id,id")
                    .bind(id)
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(db)?
                    .iter()
                    .map(|r| (Some(r.get("account_id")), "site", r.get("id"), None))
                    .collect();
                rows.extend(
                    sqlx::query("UPDATE published_pages SET taken_down_at=now() WHERE site_id=$1 AND taken_down_at IS NULL RETURNING account_id,id,source_digest")
                        .bind(id)
                        .fetch_all(&mut *tx)
                        .await
                        .map_err(db)?
                        .iter()
                        .map(|r| (Some(r.get("account_id")), "page", r.get("id"), Some(r.get("source_digest")))),
                );
                // One decision, one strike: the pages are recorded for their
                // digests, the account is counted once.
                for row in rows.iter_mut().skip(1) {
                    row.0 = None;
                }
                rows
            }
            TakedownTarget::Profile(handle) => sqlx::query("UPDATE public_profiles SET taken_down_at=now() WHERE handle=$1 AND taken_down_at IS NULL RETURNING account_id,handle")
                .bind(handle)
                .fetch_all(&mut *tx)
                .await
                .map_err(db)?
                .iter()
                .map(|r| (Some(r.get("account_id")), "profile", r.get("account_id"), Some(handle_digest(&r.get::<String, _>("handle")))))
                .collect(),
            TakedownTarget::Assistant(id) => sqlx::query("UPDATE assistant_listings SET taken_down_at=now() WHERE id=$1 AND taken_down_at IS NULL RETURNING account_id,id,encode(sha256(convert_to(instructions,'UTF8')),'hex') AS digest")
                .bind(id)
                .fetch_all(&mut *tx)
                .await
                .map_err(db)?
                .iter()
                .map(|r| (Some(r.get("account_id")), "assistant", r.get("id"), Some(r.get("digest"))))
                .collect(),
        };
        if hidden.is_empty() {
            return Err(Error::NotFound);
        }
        for (account, kind, id, digest) in &hidden {
            sqlx::query("INSERT INTO takedowns(id,account_id,target_kind,target_id,content_digest,reason) VALUES($1,$2,$3,$4,$5,$6)")
                .bind(Uuid::now_v7())
                .bind(account)
                .bind(kind)
                .bind(id)
                .bind(digest)
                .bind(reason)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            sqlx::query("UPDATE content_reports SET resolved_at=now() WHERE target_kind=$1 AND target_id=$2 AND resolved_at IS NULL")
                .bind(kind)
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(db)
    }
    /// Reports are not kept forever: closed ones go after thirty days, open
    /// ones nobody acted on after half a year.
    pub async fn prune_reports(&self) -> Result<()> {
        sqlx::query("DELETE FROM content_reports WHERE resolved_at<now()-interval '30 days' OR created_at<now()-interval '180 days'")
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }
}

/// The digest a taken-down handle is refused under, so the same address
/// cannot be claimed again by this account or any other.
fn handle_digest(handle: &str) -> String {
    use std::fmt::Write;
    let digest = sha256(format!("handle:{handle}").as_bytes());
    digest.iter().fold(String::with_capacity(64), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}
fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).into()
}
