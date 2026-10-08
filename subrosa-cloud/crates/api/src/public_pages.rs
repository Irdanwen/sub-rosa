//! The public origin (ADR 0097): published pages, profiles, their stylesheet
//! and the report form. Plain HTML from the service, no script anywhere, and
//! a policy that would refuse one if the sanitizer ever let it through.
//!
//! These routes answer only on the publication origin when it is apart from
//! the account origin, so a page written by anybody can never be served
//! where account cookies and the browser vault live.
use super::{ApiError, ClientAddress};
use axum::{
    Extension, Form, Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use std::{fmt::Write, sync::Arc};
use subrosa_domain::Error;
use subrosa_domain::publication::{PublicPage, PublicProfileView, ReportReason};
use subrosa_services::Service;
use subrosa_services::publication::{ReportSubject, render::escape};

/// No script, no frame, no plugin, nothing from elsewhere. Styles and images
/// from this origin, forms back to it.
pub const PAGE_POLICY: &str = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const STYLE: &str = include_str!("public_pages.css");

pub(super) fn routes() -> Router<Arc<Service>> {
    Router::new()
        .route("/p/{slug}", get(page))
        .route("/u/{handle}", get(profile))
        .route("/u/{handle}/avatar", get(avatar))
        .route("/_pub/style.css", get(style))
        .route("/_pub/report", post(report))
}

/// The two languages the site speaks. Only the chrome around a page follows
/// the reader; what the author wrote is what the author wrote.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lang {
    En,
    Fr,
}
impl Lang {
    fn of(headers: &HeaderMap) -> Self {
        let preferred = headers
            .get(header::ACCEPT_LANGUAGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if preferred.starts_with("fr") {
            Self::Fr
        } else {
            Self::En
        }
    }
    fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Fr => "fr",
        }
    }
    fn t(self, en: &'static str, fr: &'static str) -> &'static str {
        match self {
            Self::En => en,
            Self::Fr => fr,
        }
    }
}

/// Refuses these routes on any other origin than the publication one.
fn on_public_origin(s: &Service, headers: &HeaderMap) -> Result<(), ApiError> {
    let publication = s.config.publication.as_ref().ok_or(Error::NotFound)?;
    let authority = publication.authority();
    let account = url::Url::parse(&s.config.public_url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| u.port().map_or(h.to_string(), |p| format!("{h}:{p}")))
        })
        .unwrap_or_default();
    if authority == account {
        return Ok(());
    }
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    if host == Some(authority.as_str()) {
        Ok(())
    } else {
        Err(Error::NotFound.into())
    }
}

fn html(status: StatusCode, lang: Lang, body: String) -> Response {
    let mut response = (status, body).into_response();
    let h = response.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(PAGE_POLICY),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::VARY, HeaderValue::from_static("Accept-Language"));
    h.insert(
        header::CONTENT_LANGUAGE,
        HeaderValue::from_static(lang.code()),
    );
    response
}

/// The document around any body: language, title, stylesheet, and the
/// report form for whatever `report` names.
fn document(
    lang: Lang,
    title: &str,
    canonical: &str,
    body: &str,
    report: Option<(&str, &str)>,
    home: &str,
) -> String {
    let mut out = String::with_capacity(body.len() + 2048);
    let _ = write!(
        out,
        "<!doctype html><html lang=\"{}\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{}</title><link rel=\"stylesheet\" href=\"/_pub/style.css\"><link rel=\"canonical\" href=\"{}\"></head><body>",
        lang.code(),
        escape(title),
        escape(canonical),
    );
    out.push_str(body);
    out.push_str("<footer class=\"foot\">");
    let _ = write!(
        out,
        "<p>{} <a href=\"{}\" rel=\"noopener\">Sub Rosa</a></p>",
        lang.t("Published with", "Publié avec"),
        escape(home)
    );
    if let Some((kind, target)) = report {
        let _ = write!(
            out,
            "<details class=\"report\"><summary>{}</summary><form method=\"post\" action=\"/_pub/report\"><input type=\"hidden\" name=\"kind\" value=\"{}\"><input type=\"hidden\" name=\"target\" value=\"{}\"><label>{}<select name=\"reason\">",
            lang.t("Report this", "Signaler ce contenu"),
            escape(kind),
            escape(target),
            lang.t("Why", "Motif"),
        );
        for (value, en, fr) in [
            ("spam", "Spam or advertising", "Spam ou publicité"),
            ("abuse", "Harassment or hate", "Harcèlement ou haine"),
            ("illegal", "Illegal content", "Contenu illégal"),
            (
                "privacy",
                "Someone's private information",
                "Informations privées d’une personne",
            ),
            ("other", "Something else", "Autre chose"),
        ] {
            let _ = write!(out, "<option value=\"{value}\">{}</option>", lang.t(en, fr));
        }
        let _ = write!(
            out,
            "</select></label><label>{}<textarea name=\"detail\" maxlength=\"500\" rows=\"3\"></textarea></label><button type=\"submit\">{}</button></form></details>",
            lang.t("Details (optional)", "Précisions (facultatif)"),
            lang.t("Send the report", "Envoyer le signalement"),
        );
    }
    out.push_str("</footer></body></html>");
    out
}

fn not_found(lang: Lang, home: &str) -> Response {
    let title = lang.t("This page is not here", "Cette page n’existe pas");
    let body = format!(
        "<main class=\"page\"><h1>{title}</h1><p>{}</p></main>",
        lang.t(
            "It was unpublished, taken down, or the address is wrong.",
            "Elle a été dépubliée, retirée, ou l’adresse est inexacte.",
        )
    );
    html(
        StatusCode::NOT_FOUND,
        lang,
        document(lang, title, home, &body, None, home),
    )
}

fn render_page(page: &PublicPage, lang: Lang, origin: &str, home: &str) -> String {
    let mut body = String::with_capacity(page.html.len() + 1024);
    if let Some(site) = &page.site {
        body.push_str("<header class=\"site\">");
        match &site.home_slug {
            Some(home_slug) => {
                let _ = write!(
                    body,
                    "<a class=\"site-title\" href=\"/p/{}\">{}</a>",
                    escape(home_slug),
                    escape(&site.title)
                );
            }
            None => {
                let _ = write!(
                    body,
                    "<span class=\"site-title\">{}</span>",
                    escape(&site.title)
                );
            }
        }
        let _ = write!(
            body,
            "<nav aria-label=\"{}\"><ul>",
            lang.t("Pages of this site", "Pages de ce site")
        );
        for (slug, title) in &site.pages {
            let current = if *slug == page.slug {
                " aria-current=\"page\""
            } else {
                ""
            };
            let _ = write!(
                body,
                "<li><a href=\"/p/{}\"{current}>{}</a></li>",
                escape(slug),
                escape(title)
            );
        }
        body.push_str("</ul></nav></header>");
    }
    let _ = write!(
        body,
        "<main class=\"page\"><article><h1>{}</h1>{}</article><p class=\"updated\">{} {}</p></main>",
        escape(&page.title),
        page.html,
        lang.t("Updated", "Mis à jour le"),
        page.updated_at.format("%Y-%m-%d"),
    );
    document(
        lang,
        &page.title,
        &format!("{origin}/p/{}", page.slug),
        &body,
        Some(("page", &page.slug)),
        home,
    )
}

fn render_profile(view: &PublicProfileView, lang: Lang, origin: &str, home: &str) -> String {
    let profile = &view.profile;
    let mut body = String::from("<main class=\"page profile\"><header class=\"who\">");
    if profile.has_avatar {
        let _ = write!(
            body,
            "<img class=\"avatar\" src=\"/u/{}/avatar\" alt=\"\" width=\"72\" height=\"72\">",
            escape(&profile.handle)
        );
    }
    let _ = write!(
        body,
        "<div><h1>{}</h1><p class=\"handle\">@{}</p></div></header>",
        escape(&profile.display_name),
        escape(&profile.handle)
    );
    if !profile.bio.is_empty() {
        let _ = write!(body, "<p class=\"bio\">{}</p>", escape(&profile.bio));
    }
    let section = |body: &mut String, heading: &str, items: Vec<(String, String, String)>| {
        if items.is_empty() {
            return;
        }
        let _ = write!(body, "<section><h2>{heading}</h2><ul class=\"list\">");
        for (href, title, detail) in items {
            let _ = write!(
                body,
                "<li><a href=\"{}\">{}</a>",
                escape(&href),
                escape(&title)
            );
            if !detail.is_empty() {
                let _ = write!(body, "<span>{}</span>", escape(&detail));
            }
            body.push_str("</li>");
        }
        body.push_str("</ul></section>");
    };
    section(
        &mut body,
        lang.t("Sites", "Sites"),
        view.sites
            .iter()
            .map(|(title, slug)| (format!("/p/{slug}"), title.clone(), String::new()))
            .collect(),
    );
    section(
        &mut body,
        lang.t("Pages", "Pages"),
        view.pages
            .iter()
            .map(|(slug, title)| (format!("/p/{slug}"), title.clone(), String::new()))
            .collect(),
    );
    section(
        &mut body,
        lang.t("Assistants", "Assistants"),
        view.assistants
            .iter()
            .map(|(id, name, description)| {
                (
                    format!("{home}/assistants/{id}"),
                    name.clone(),
                    description.clone(),
                )
            })
            .collect(),
    );
    body.push_str("</main>");
    document(
        lang,
        &profile.display_name,
        &format!("{origin}/u/{}", profile.handle),
        &body,
        Some(("profile", &profile.handle)),
        home,
    )
}

async fn page(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Response, ApiError> {
    on_public_origin(&s, &h)?;
    let lang = Lang::of(&h);
    let home = s.config.public_url.clone();
    match s.public_page(&slug).await {
        Ok(page) => {
            let origin = s.config.publication.as_ref().map_or("", |p| p.url.as_str());
            Ok(html(
                StatusCode::OK,
                lang,
                render_page(&page, lang, origin, &home),
            ))
        }
        Err(Error::NotFound) => Ok(not_found(lang, &home)),
        Err(e) => Err(e.into()),
    }
}
async fn profile(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(handle): Path<String>,
) -> Result<Response, ApiError> {
    on_public_origin(&s, &h)?;
    let lang = Lang::of(&h);
    let home = s.config.public_url.clone();
    match s.public_profile(&handle).await {
        Ok(view) => {
            let origin = s.config.publication.as_ref().map_or("", |p| p.url.as_str());
            Ok(html(
                StatusCode::OK,
                lang,
                render_profile(&view, lang, origin, &home),
            ))
        }
        Err(Error::NotFound) => Ok(not_found(lang, &home)),
        Err(e) => Err(e.into()),
    }
}
async fn avatar(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(handle): Path<String>,
) -> Result<Response, ApiError> {
    on_public_origin(&s, &h)?;
    let (bytes, kind) = s.avatar(&handle).await?;
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&kind).map_err(|_| Error::Unavailable)?,
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    Ok(response)
}
async fn style(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response, ApiError> {
    on_public_origin(&s, &h)?;
    Ok(([(header::CONTENT_TYPE, "text/css; charset=utf-8")], STYLE).into_response())
}

#[derive(Deserialize)]
struct ReportForm {
    kind: String,
    target: String,
    reason: String,
    #[serde(default)]
    detail: String,
}
/// The form at the foot of every public page. It works without script, and
/// answers with a page rather than JSON because a browser shows the answer.
async fn report(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Extension(client): Extension<ClientAddress>,
    Form(form): Form<ReportForm>,
) -> Result<Response, ApiError> {
    on_public_origin(&s, &h)?;
    let lang = Lang::of(&h);
    let home = s.config.public_url.clone();
    let subject = match form.kind.as_str() {
        "page" => ReportSubject::PageSlug(&form.target),
        "profile" => ReportSubject::Handle(&form.target),
        _ => return Err(Error::Invalid.into()),
    };
    let reason = ReportReason::parse(&form.reason).ok_or(Error::Invalid)?;
    let (status, title, text) = match s.report(subject, reason, &form.detail, &client.0).await {
        Ok(()) => (
            StatusCode::OK,
            lang.t("Thank you", "Merci"),
            lang.t(
                "Your report was sent. The people who run this service read every one.",
                "Votre signalement a été envoyé. Les personnes qui gèrent ce service les lisent tous.",
            ),
        ),
        Err(Error::RateLimited) => (
            StatusCode::TOO_MANY_REQUESTS,
            lang.t("Please wait", "Veuillez patienter"),
            lang.t(
                "Too many reports were sent from here. Try again in a minute.",
                "Trop de signalements envoyés d’ici. Réessayez dans une minute.",
            ),
        ),
        Err(Error::NotFound) => return Ok(not_found(lang, &home)),
        Err(e) => return Err(e.into()),
    };
    let body = format!("<main class=\"page\"><h1>{title}</h1><p>{text}</p></main>");
    Ok(html(
        status,
        lang,
        document(lang, title, &home, &body, None, &home),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use subrosa_domain::publication::{PublicProfile, SiteNavigation};
    use uuid::Uuid;

    fn page(title: &str, html: &str) -> PublicPage {
        PublicPage {
            id: Uuid::nil(),
            slug: "my-page".into(),
            title: title.into(),
            html: html.into(),
            updated_at: Utc::now(),
            site: Some(SiteNavigation {
                title: "Site <b>".into(),
                home_slug: Some("home-page".into()),
                pages: vec![
                    ("home-page".into(), "Home".into()),
                    ("my-page".into(), "Mine \"quoted\"".into()),
                ],
            }),
        }
    }

    /// Everything the author typed outside the sanitized body is escaped where
    /// it lands, and the page carries no script of its own.
    #[test]
    fn a_page_escapes_every_author_string_and_runs_nothing() {
        let out = render_page(
            &page("<script>alert(1)</script>", "<p>body</p>"),
            Lang::En,
            "https://pages.example",
            "https://account.example",
        );
        assert!(!out.contains("<script"), "{out}");
        assert!(out.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(out.contains("Site &lt;b&gt;"));
        assert!(out.contains("Mine &quot;quoted&quot;"));
        assert!(out.contains("aria-current=\"page\""));
        assert!(out.contains("<link rel=\"canonical\" href=\"https://pages.example/p/my-page\">"));
        assert!(out.contains("action=\"/_pub/report\""));
        assert!(!out.contains(" style="));
    }

    #[test]
    fn the_chrome_follows_the_reader_and_the_text_does_not() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_LANGUAGE,
            HeaderValue::from_static("fr-CH,fr;q=0.9,en;q=0.8"),
        );
        let lang = Lang::of(&headers);
        let out = render_page(&page("Title", "<p>English text</p>"), lang, "o", "h");
        assert!(out.contains("<html lang=\"fr\">"));
        assert!(out.contains("Signaler ce contenu"));
        assert!(out.contains("English text"));
    }

    #[test]
    fn a_profile_lists_what_it_published_and_escapes_its_bio() {
        let view = PublicProfileView {
            profile: PublicProfile {
                handle: "morgan".into(),
                display_name: "Morgan <i>".into(),
                bio: "Writes \"things\" & <stuff>".into(),
                has_avatar: true,
                updated_at: Utc::now(),
                taken_down: false,
            },
            sites: vec![("Garden".into(), "garden-home".into())],
            pages: vec![("loose-page".into(), "Loose".into())],
            assistants: vec![(Uuid::nil(), "Editor".into(), "Edits".into())],
        };
        let out = render_profile(
            &view,
            Lang::En,
            "https://pages.example",
            "https://acct.example",
        );
        assert!(out.contains("Morgan &lt;i&gt;"));
        assert!(out.contains("Writes &quot;things&quot; &amp; &lt;stuff&gt;"));
        assert!(out.contains("href=\"/p/garden-home\""));
        assert!(out.contains("href=\"/p/loose-page\""));
        assert!(out.contains(&format!(
            "href=\"https://acct.example/assistants/{}\"",
            Uuid::nil()
        )));
        assert!(out.contains("src=\"/u/morgan/avatar\""));
        assert!(!out.contains("<script"));
    }
}
