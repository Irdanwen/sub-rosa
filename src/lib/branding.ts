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

/** Default, editable base URL for the Carpe Diem OpenAI-compatible endpoint. */
export const CARPE_DIEM_DEFAULT_BASE_URL = "https://carpe-diem.xyz/api/operator/v1";

/** Where a user creates a key and buys credits. Linked from onboarding. */
export const CARPE_DIEM_DASHBOARD_URL = "https://carpe-diem.xyz";

/** Prefix every Carpe Diem API key carries (`cdm_…`); used for light UI hints. */
export const CARPE_DIEM_KEY_PREFIX = "cdm_";
