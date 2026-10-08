/**
 * The website in the app's six languages (ADR-0047, website addendum).
 *
 * Copy is written as a pair in the code, `t("English", "Français")`, and
 * data as `Copy` pairs read through `t`. German, Italian, Spanish and
 * Brazilian Portuguese come from catalogs keyed by the English sentence
 * (`website/src/locales/`), which `scripts/i18n/website.mjs` keeps in step
 * with the code and `src/test/website-i18n-catalog.test.ts` holds complete.
 * A sentence a catalog lacks reads in English, never as a broken key.
 *
 * A sentence built from a template is keyed with `{name}` placeholders
 * ("{count} tools"). `t` receives it filled in, so it matches the filled
 * sentence back against those keys and fills the translation with the same
 * values: the call sites stay pairs of plain template strings.
 *
 * Catalogs are loaded per language and per part, with the code that shows
 * them: `site` before the first render, `app` with the web client, `models`
 * with the model catalog and `models:<kind>` with a kind's detail chunk.
 */

export type SiteLocale = "en" | "fr" | "de" | "it" | "es" | "pt-BR";
/** `models:<kind>` is a kind's family depth, loaded with its detail chunk. */
export type MessagePart = "site" | "app" | "models" | `models:${string}`;

/** Every language the site speaks, in the order the picker lists them. */
export const SITE_LOCALES: readonly SiteLocale[] = ["en", "fr", "de", "it", "es", "pt-BR"];

/** Each language named in itself, as the app's picker names it. */
export const LOCALE_NAMES: Record<SiteLocale, string> = {
  en: "English",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  es: "Español",
  "pt-BR": "Português (Brasil)",
};

/** The short code the language switch shows. */
export const LOCALE_CODES: Record<SiteLocale, string> = {
  en: "EN",
  fr: "FR",
  de: "DE",
  it: "IT",
  es: "ES",
  "pt-BR": "PT",
};

const INTL_TAGS: Record<SiteLocale, string> = {
  en: "en-US",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  es: "es-ES",
  "pt-BR": "pt-BR",
};

export const isSiteLocale = (value: unknown): value is SiteLocale =>
  SITE_LOCALES.includes(value as SiteLocale);

/**
 * A language tag reduced to a language the site has: the language subtag
 * decides, so `de-CH` reads German and any Portuguese the Brazilian one.
 * Null for a language the site does not speak.
 */
export function siteLocaleFromTag(tag: string | null | undefined): SiteLocale | null {
  if (!tag) return null;
  const language = tag.toLowerCase().split(/[-_.]/)[0];
  if (language === "pt") return "pt-BR";
  return isSiteLocale(language) ? language : null;
}

/** The path segment of a public page in a language: "" in English, "/fr", "/pt-br". */
export const localePrefix = (locale: SiteLocale) =>
  locale === "en" ? "" : `/${locale.toLowerCase()}`;

/** A public path's language (null without a prefix) and the page it names. */
export function splitLocalePath(path: string): { locale: SiteLocale | null; page: string } {
  for (const locale of SITE_LOCALES) {
    const prefix = localePrefix(locale);
    if (!prefix) continue;
    if (path === prefix || path === `${prefix}/`) return { locale, page: "/" };
    if (path.startsWith(`${prefix}/`)) return { locale, page: path.slice(prefix.length) };
  }
  return { locale: null, page: path };
}

/** A public page in a language: `/docs` in German is `/de/docs`, home is `/de/`. */
export function localizedPublicPath(page: string, locale: SiteLocale) {
  const prefix = localePrefix(locale);
  if (!prefix) return page;
  return page === "/" ? `${prefix}/` : `${prefix}${page}`;
}

let language: SiteLocale = "en";
const preferenceKey = "subrosa:website-language";

export function setWebsiteLocale(locale: SiteLocale) {
  language = locale;
}

export function websiteLocale(): SiteLocale {
  return language;
}

/** A BCP 47 tag for `Intl` (dates, numbers) in the current language. */
export function intlLocale(): string {
  return INTL_TAGS[language];
}

export function savedWebsiteLocale(): SiteLocale | null {
  try {
    const saved = localStorage.getItem(preferenceKey);
    return isSiteLocale(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function rememberWebsiteLocale(locale: SiteLocale) {
  setWebsiteLocale(locale);
  try {
    localStorage.setItem(preferenceKey, locale);
  } catch {
    // A blocked storage API must not block navigation or translation.
  }
}

/** The first of the browser's languages the site speaks. */
export function browserWebsiteLocale(languages: string | readonly string[]): SiteLocale | null {
  for (const tag of typeof languages === "string" ? [languages] : languages) {
    const locale = siteLocaleFromTag(tag);
    if (locale) return locale;
  }
  return null;
}

/** `?lang=` as a language the site has, accepting `pt-br` and `pt`. */
export function requestedWebsiteLocale(search: string): SiteLocale | null {
  const requested = new URLSearchParams(search).get("lang");
  if (!requested) return null;
  if (isSiteLocale(requested)) return requested;
  return siteLocaleFromTag(requested);
}

export function initialWebsiteLocale(
  path: string,
  search = "",
  browserLanguage: string | readonly string[] = "en",
): SiteLocale {
  const prefixed = splitLocalePath(path).locale;
  if (prefixed) return prefixed;
  return (
    requestedWebsiteLocale(search) ??
    savedWebsiteLocale() ??
    browserWebsiteLocale(browserLanguage) ??
    "en"
  );
}

// Catalogs: one JSON file per part and language, each its own chunk.

type Messages = Record<string, string>;
type Template = { pattern: RegExp; names: string[]; value: string; weight: number };
type Table = {
  exact: Map<string, string>;
  templates: Template[] | null;
  matched: Map<string, string | null>;
};

const sources = import.meta.glob<Messages>("../locales/**/*.json", { import: "default" });
const sourceOf = (part: MessagePart, locale: SiteLocale) =>
  sources[`../locales/${part === "site" ? "" : `${part.replace(":", "/")}/`}${locale}.json`];

const wanted = new Set<MessagePart>(["site"]);
const loading = new Map<string, Promise<void>>();
const tables = new Map<SiteLocale, Table>();

const translated = (locale: SiteLocale) => locale !== "en" && locale !== "fr";

function loadPart(part: MessagePart, locale: SiteLocale): Promise<void> {
  const id = `${part}/${locale}`;
  const known = loading.get(id);
  if (known) return known;
  const source = sourceOf(part, locale);
  const next = (source ? source() : Promise.resolve<Messages>({})).then((messages) => {
    const table: Table = tables.get(locale) ?? {
      exact: new Map(),
      templates: null,
      matched: new Map(),
    };
    for (const [key, value] of Object.entries(messages)) if (value) table.exact.set(key, value);
    table.templates = null;
    table.matched.clear();
    tables.set(locale, table);
  });
  loading.set(id, next);
  return next;
}

/** Loads the parts the page needs in a language. English and French need none. */
export function loadWebsiteMessages(locale: SiteLocale = language): Promise<void> {
  if (!translated(locale)) return Promise.resolve();
  return Promise.all([...wanted].map((part) => loadPart(part, locale))).then(() => undefined);
}

/** Marks a part as needed from now on (the web client, the model catalog) and loads it. */
export function requireWebsiteMessages(part: MessagePart, locale: SiteLocale = language) {
  wanted.add(part);
  return loadWebsiteMessages(locale);
}

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A templated key as a pattern; a space next to a value may be missing (`(85 %)` / `(85%)`). */
function compile(key: string, value: string): Template | null {
  const pieces = key.split(/\{(\w+)\}/);
  if (pieces.length < 3) return null;
  const literal = pieces.filter((_, index) => index % 2 === 0).join("");
  const weight = literal.replace(/[^\p{L}]/gu, "").length;
  // A key that is nearly all values would match sentences it never wrote.
  if (weight < 3) return null;
  const names: string[] = [];
  let source = "^";
  pieces.forEach((piece, index) => {
    if (index % 2 === 1) {
      names.push(piece);
      source += "([\\s\\S]*?)";
      return;
    }
    let text = escapePattern(piece);
    if (index > 0 && text.startsWith(" ")) text = ` ?${text.slice(1)}`;
    if (index < pieces.length - 1 && text.endsWith(" ")) text = `${text.slice(0, -1)} ?`;
    source += text;
  });
  return { pattern: new RegExp(`${source}$`, "u"), names, value, weight };
}

function matchTemplate(table: Table, sentence: string): string | null {
  const known = table.matched.get(sentence);
  if (known !== undefined) return known;
  table.templates ??= [...table.exact]
    .filter(([key]) => /\{\w+\}/.test(key))
    .map(([key, value]) => compile(key, value))
    .filter((template): template is Template => template !== null)
    .sort((a, b) => b.weight - a.weight);
  let result: string | null = null;
  for (const template of table.templates) {
    const match = template.pattern.exec(sentence);
    if (!match) continue;
    const values = new Map(template.names.map((name, index) => [name, match[index + 1]]));
    result = template.value.replace(
      /\{(\w+)\}/g,
      (whole, name: string) => values.get(name) ?? whole,
    );
    break;
  }
  if (table.matched.size > 2000) table.matched.clear();
  table.matched.set(sentence, result);
  return result;
}

/**
 * The sentence in the current language. A sentence that reads two ways in
 * French has a key per French reading (`Back [fr: Verso]`), so its other
 * languages can tell them apart too.
 */
export function t(en: string, fr: string): string {
  if (language === "en") return en;
  if (language === "fr") return fr;
  const table = tables.get(language);
  if (!table) return en;
  return (
    table.exact.get(`${en} [fr: ${fr}]`) ?? table.exact.get(en) ?? matchTemplate(table, en) ?? en
  );
}

export function date(value: string) {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
export function number(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat(language, { maximumFractionDigits }).format(value);
}
