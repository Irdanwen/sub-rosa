import { localizedPublicPath, SITE_LOCALES } from "./i18n";

/**
 * Where each known deployment answers, by the base it is built with: the
 * public site under `/subrosa/` on furetier.com, and the dedicated account
 * website at the root of its own origin. `VITE_SITE_ORIGIN` names any other.
 */
const KNOWN_ORIGINS: Record<string, string> = {
  "/subrosa/": "https://furetier.com",
  "/": "https://subrosa.furetier.com",
};

/** The HTTPS origin a build's public pages are served from. */
export function siteOrigin(base: string, configured = ""): string {
  const origin = configured || KNOWN_ORIGINS[base];
  if (!origin) throw new Error(`Set VITE_SITE_ORIGIN for a website built under ${base}.`);
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin)
    throw new Error("VITE_SITE_ORIGIN must be an HTTPS origin without a path.");
  return origin;
}

/**
 * The `<link rel="alternate">` tags a prerendered public page carries: one
 * per language and an `x-default`, each an absolute URL, as hreflang requires.
 */
export function alternateLinks(page: string, base: string, origin: string): string {
  const root = `${origin}${base.replace(/\/$/, "")}`;
  return [
    ...SITE_LOCALES.map(
      (locale) =>
        `<link rel="alternate" hreflang="${locale}" href="${root}${localizedPublicPath(page, locale)}" />`,
    ),
    `<link rel="alternate" hreflang="x-default" href="${root}${page}" />`,
  ].join("");
}
