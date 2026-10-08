//! The one-tap catalog: remote MCP servers their vendors host and document,
//! that sign in with OAuth on their own (dynamic client registration) or need
//! no sign-in at all, over Streamable HTTP (ADR-0092).
//!
//! Every address below was read on the vendor's own documentation page on
//! 2026-10-08, and the page is named above it. Servers that need a client
//! registered by hand (GitHub, Asana, HubSpot, Box, Atlassian's current
//! server) or that admit only clients they approved (Vercel, Figma) are not
//! here: a tap that ends in "this app is not allowed" is not one tap. They
//! remain reachable as custom connectors, with a token, in developer mode.
//!
//! Each host is declared in `crate::egress`, so the Privacy screen lists it.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    /// What it lets the assistant do, in a few words.
    pub description: &'static str,
    /// `oauth` (signs in in the browser) or `none`.
    pub auth: &'static str,
}

const fn entry(
    id: &'static str,
    name: &'static str,
    url: &'static str,
    description: &'static str,
    auth: &'static str,
) -> CatalogEntry {
    CatalogEntry {
        id,
        name,
        url,
        description,
        auth,
    }
}

pub const CATALOG: &[CatalogEntry] = &[
    // Read on https://developers.notion.com/docs/get-started-with-mcp
    entry(
        "notion",
        "Notion",
        "https://mcp.notion.com/mcp",
        "Search, read and update pages and databases",
        "oauth",
    ),
    // Read on https://linear.app/docs/mcp
    entry(
        "linear",
        "Linear",
        "https://mcp.linear.app/mcp",
        "Find, create and update issues and projects",
        "oauth",
    ),
    // Read on https://mcp.sentry.dev
    entry(
        "sentry",
        "Sentry",
        "https://mcp.sentry.dev/mcp",
        "Look into errors, issues and releases",
        "oauth",
    ),
    // Read on https://docs.stripe.com/mcp
    entry(
        "stripe",
        "Stripe",
        "https://mcp.stripe.com",
        "Look up customers, payments and invoices",
        "oauth",
    ),
    // Read on https://docs.zapier.com/mcp/overview/how-connections-work
    entry(
        "zapier",
        "Zapier",
        "https://mcp.zapier.com/api/v1/connect",
        "Run the actions you set up in Zapier",
        "oauth",
    ),
    // Read on https://developer.squareup.com/docs/mcp
    entry(
        "square",
        "Square",
        "https://mcp.squareup.com/mcp",
        "Look up orders, payments and catalog items",
        "oauth",
    ),
    // Read on https://developers.intercom.com/docs/guides/mcp
    entry(
        "intercom",
        "Intercom",
        "https://mcp.intercom.com/mcp",
        "Search conversations and contacts",
        "oauth",
    ),
    // Read on https://developer.monday.com/api-reference/docs/mondaycom-mcp
    entry(
        "monday",
        "monday.com",
        "https://mcp.monday.com/mcp",
        "Read and update boards and items",
        "oauth",
    ),
    // Read on https://developers.webflow.com/mcp/reference/getting-started
    entry(
        "webflow",
        "Webflow",
        "https://mcp.webflow.com/mcp",
        "Read and edit sites and CMS collections",
        "oauth",
    ),
    // Read on https://huggingface.co/docs/hub/hf-mcp-server
    entry(
        "huggingface",
        "Hugging Face",
        "https://huggingface.co/mcp",
        "Search models, datasets and papers",
        "oauth",
    ),
    // Read on https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/
    entry(
        "cloudflare-docs",
        "Cloudflare docs",
        "https://docs.mcp.cloudflare.com/mcp",
        "Search Cloudflare's documentation, no account needed",
        "none",
    ),
];

pub fn find(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|entry| entry.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_is_https_unique_and_declared() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|entry| entry.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len(), "a catalog id is listed twice");
        for entry in CATALOG {
            let url = super::super::mcp::validate_endpoint(entry.url).expect("valid address");
            assert_eq!(url.scheme(), "https", "{} must be https", entry.id);
            let host = url.host_str().unwrap_or_default();
            assert!(
                crate::egress::DECLARED_EGRESS
                    .iter()
                    .any(|declared| declared.host == host),
                "{host} is in the catalog but not on the Privacy screen"
            );
            assert!(matches!(entry.auth, "oauth" | "none"));
            assert!(
                !entry.description.contains('\u{2014}') && !entry.description.contains('\u{2013}')
            );
        }
    }
}
