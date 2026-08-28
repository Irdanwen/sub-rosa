// Distribution flavor for the Sub Rosa fork of June (open-software-network/os-june, MIT).
//
// Centralizes every user-visible brand string and the Carpe Diem defaults so
// the fork's diff against upstream stays small and the rebrand is auditable in
// one place. Technical identifiers (env var names, `june://` event names,
// module names, localStorage keys) intentionally stay as-is upstream to keep
// merges clean — only user-facing copy points here.

/** Product name shown to the user (window titles, onboarding, About, menus). */
export const PRODUCT_NAME = "Sub Rosa";

/** macOS/Windows bundle identifier. Mirrors tauri.conf.json `identifier`. */
export const BUNDLE_IDENTIFIER = "xyz.carpediem.subrosa";

/** Custom deep-link / URL scheme. Mirrors tauri.conf.json deep-link config. */
export const DEEP_LINK_SCHEME = "subrosa";

/** Attribution required by June's MIT license; shown in About + README. */
export const UPSTREAM_ATTRIBUTION = "Based on June (open-software-network/os-june), MIT.";

// --- Carpe Diem provider defaults ------------------------------------------

/**
 * Default, editable base URL for the Carpe Diem OpenAI-compatible endpoint —
 * the `/router` best-price aggregator rail. Chat, embeddings, and audio route
 * through it; endpoints absent from `/router` (model catalog, image/video, web
 * augmentation, credits/pricing) are derived onto the `/v1` rail in the Rust
 * layer. The functional default lives in `src-tauri` `carpe_diem::branding`;
 * keep this mirror in sync. Installs that already stored `/v1` keep it.
 */
export const CARPE_DIEM_DEFAULT_BASE_URL = "https://carpe-diem.xyz/api/operator/router";

/** Where a user creates a key and buys credits. Linked from onboarding. */
export const CARPE_DIEM_DASHBOARD_URL = "https://carpe-diem.xyz";

/**
 * The provider, for the surfaces that report one.
 *
 * Safe to state rather than read back: this binary contacts Carpe Diem and
 * nothing else (ADR-0017), so a surface with no provider in its payload is
 * missing a field, not looking at a different operator.
 */
export const PROVIDER_NAME = "Carpe Diem";

/** Prefix every Carpe Diem API key carries (`cdm_…`); used for light UI hints. */
export const CARPE_DIEM_KEY_PREFIX = "cdm_";
