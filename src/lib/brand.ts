// Brand accent preference. The whole UI derives from the --brand token
// (src/styles/tokens.css) via var(--brand) and color-mix, so overriding that
// one custom property at runtime recolors buttons, washes, hovers, and the
// recorder accent in one shot.
//
// Each value here is a DISPLAY tone: it is a wash, a tint and a mark, and it is
// never asked to carry text. Everything that does carry text reads --brand-ink,
// which tokens.css derives from this value per theme. That split is why these
// can be the saturated, recognisable tones rather than the darkened ones a
// foreground would force — and src/test/contrast.test.ts runs the derivation
// over every preset in both themes, so adding one is no longer a coin flip.
//
// The native dock icon swaps to the selected accent in Tauri builds.
//
// Keep the storage key + the id->hex map in sync with the pre-paint bootstrap
// in index.html, which sets --brand before the bundle runs to avoid a flash.

import { invoke } from "@tauri-apps/api/core";

export type BrandId = "gold" | "rose" | "clay" | "amber" | "sage" | "blue" | "plum";

export const BRAND_PRESETS: { id: BrandId; label: string; value: string }[] = [
  // The house gold (--sr-gold-display). First in the list and the default,
  // because it is the accent the website and Carpe Diem already wear.
  { id: "gold", label: "Gold", value: "#c9973f" },
  { id: "rose", label: "Rose", value: "#936862" },
  { id: "clay", label: "Clay", value: "#9d5728" },
  { id: "amber", label: "Amber", value: "#8b6e4d" },
  { id: "sage", label: "Sage", value: "#607d65" },
  { id: "blue", label: "Blue", value: "#597893" },
  { id: "plum", label: "Plum", value: "#886885" },
];

const STORAGE_KEY = "os-june:brand";
export const DEFAULT_BRAND: BrandId = "gold";

function presetFor(id: string | null) {
  return BRAND_PRESETS.find((preset) => preset.id === id) ?? BRAND_PRESETS[0];
}

export function getStoredBrand(): BrandId {
  try {
    return presetFor(localStorage.getItem(STORAGE_KEY)).id;
  } catch {
    // localStorage can throw in sandboxed contexts.
    return DEFAULT_BRAND;
  }
}

const ACCENT_EVENT = "june://accent";
const BRAND_TRANSITION_MS = 220;
const BRAND_TRANSITION_BUFFER_MS = 80;
let brandTransitionTimer: number | undefined;

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function applyWithTransition(apply: () => void) {
  const root = document.documentElement;
  if (prefersReducedMotion()) {
    apply();
    return;
  }

  window.clearTimeout(brandTransitionTimer);
  root.setAttribute("data-brand-transition", "true");
  window.requestAnimationFrame(() => {
    apply();
    brandTransitionTimer = window.setTimeout(() => {
      root.removeAttribute("data-brand-transition");
    }, BRAND_TRANSITION_MS + BRAND_TRANSITION_BUFFER_MS);
  });
}

export function setStoredBrand(id: BrandId) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Apply still works for this session.
  }
  applyBrand(id, { animate: true });
  // Tell the separate HUD webviews (agent/meeting/recording) to recolor too.
  if (inTauri()) {
    window.setTimeout(() => {
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit(ACCENT_EVENT, id))
        .catch(() => {});
    }, BRAND_TRANSITION_MS);
  }
}

// CSS-only apply: inline style on <html> overrides the :root default in
// tokens.css and cascades to every var(--brand) consumer. Fixed across
// light/dark, so a single value covers both themes.
export function applyBrandVar(id: BrandId, options: { animate?: boolean } = {}) {
  const apply = () => document.documentElement.style.setProperty("--brand", presetFor(id).value);
  if (options.animate) {
    applyWithTransition(apply);
  } else {
    apply();
  }
}

// Main window: recolor + swap the native dock icon.
export function applyBrand(id: BrandId, options: { animate?: boolean } = {}) {
  applyBrandVar(id, options);
  syncDockIcon(id, options.animate ? BRAND_TRANSITION_MS : 0);
}

// Swap the native macOS dock/Cmd-Tab icon to match the accent. No-op on the
// web preview (no Tauri) and on builds that predate the command.
function syncDockIcon(id: BrandId, delayMs = 0) {
  if (!inTauri()) return;
  window.setTimeout(() => {
    void invoke("set_dock_icon", { brand: id }).catch(() => {
      // Best-effort: keep the bundled default icon if the command is absent.
    });
  }, delayMs);
}

export function initBrand() {
  applyBrand(getStoredBrand());
}

// Secondary windows (HUDs): apply the stored accent on load and keep it in
// sync when the main window changes it.
export function subscribeBrand() {
  applyBrandVar(getStoredBrand());
  if (!inTauri()) return;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<BrandId>(ACCENT_EVENT, (event) => applyBrandVar(event.payload, { animate: true })),
  );
}
