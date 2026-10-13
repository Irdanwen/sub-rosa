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

/**
 * What a shared link of a public page shows: its title, its description and
 * the Studio picture, for every network that reads Open Graph or Twitter
 * cards, plus the canonical address of this language's page.
 */
export function shareTags({
  page,
  locale,
  base,
  origin,
  title,
  description,
}: {
  page: string;
  locale: string;
  base: string;
  origin: string;
  title: string;
  description: string;
}): string {
  const root = `${origin}${base.replace(/\/$/, "")}`;
  const url = `${root}${localizedPublicPath(page, locale as (typeof SITE_LOCALES)[number])}`;
  const image = `${root}/studio-preview-${locale === "fr" ? "fr" : "en"}.png`;
  const attribute = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return [
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Sub Rosa" />`,
    `<meta property="og:locale" content="${locale.replace("-", "_")}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${attribute(title)}" />`,
    `<meta property="og:description" content="${attribute(description)}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${attribute(title)}" />`,
    `<meta name="twitter:description" content="${attribute(description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
  ].join("");
}

/** Every prerendered page in every language, for sitemap.xml. */
export function sitemap(pages: readonly string[], base: string, origin: string): string {
  const root = `${origin}${base.replace(/\/$/, "")}`;
  const urls = pages.flatMap((page) =>
    SITE_LOCALES.map(
      (locale) => `  <url><loc>${root}${localizedPublicPath(page, locale)}</loc></url>`,
    ),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
