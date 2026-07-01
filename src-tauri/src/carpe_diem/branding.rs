//! Distribution flavor for the Sub Rosa fork (of June / os-june, MIT).
//!
//! Central home for the fork's brand identifiers so the diff against upstream
//! stays concentrated in one module. Keep these in sync with
//! `tauri.conf.json`, `src/lib/branding.ts`, and the icon set.

/// Product name shown to the user.
pub const PRODUCT_NAME: &str = "Sub Rosa";

/// Bundle identifier — mirrors `tauri.conf.json` `identifier`. Also the base
/// for TCC (privacy) prompts and the OS keychain service name.
pub const BUNDLE_IDENTIFIER: &str = "xyz.carpediem.subrosa";

/// Custom URL / deep-link scheme (release OAuth callback + deep links).
pub const DEEP_LINK_SCHEME: &str = "subrosa";

/// Where a user creates a Carpe Diem key and buys credits.
pub const CARPE_DIEM_DASHBOARD_URL: &str = "https://carpe-diem.xyz";

/// Default, user-editable Carpe Diem base URL (OpenAI-compatible endpoint).
pub const CARPE_DIEM_DEFAULT_BASE_URL: &str = "https://carpe-diem.xyz/api/operator/v1";
