/**
 * The app in the person's language (ADR-0047).
 *
 * Copy is written in English in the code, and the English sentence is the
 * key: `t("Export as PDF")`. A catalog per language maps that sentence to
 * its translation; a sentence the catalog does not have comes back as
 * written, so a missing translation is a visible English sentence, never
 * a broken key, and the gate in `src/test/i18n-catalog.test.ts` is what
 * keeps the catalog complete.
 *
 * Variables are `{name}` placeholders: `t("{count} notes", { count })`.
 * The translation may reorder them and must keep every name; the gate
 * checks that too.
 *
 * The locale is a per-device choice ("system", or a language), kept in
 * localStorage and applied at the root: switching it re-renders the shell.
 */

import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import it from "../locales/it.json";
import ptBR from "../locales/pt-BR.json";

export type Locale = "en" | "fr" | "de" | "it" | "es" | "pt-BR";
export type LocaleChoice = "system" | Locale;

export const LOCALE_STORAGE_KEY = "os-june:locale";
/** Every language the app speaks, in the order the pickers list them. */
export const SUPPORTED_LOCALES: Locale[] = ["en", "fr", "de", "it", "es", "pt-BR"];

const catalogs: Record<Locale, Record<string, string>> = {
  en: {},
  fr: fr as Record<string, string>,
  de: de as Record<string, string>,
  it: it as Record<string, string>,
  es: es as Record<string, string>,
  "pt-BR": ptBR as Record<string, string>,
};

/**
 * A language tag reduced to a language the app has: the language subtag
 * decides, so `de-CH` reads German and any Portuguese reads the Brazilian
 * catalog, the only Portuguese the app has. English otherwise.
 */
export function localeFromTag(tag: string): Locale {
  const language = tag.toLowerCase().split(/[-_.]/)[0];
  if (language === "pt") return "pt-BR";
  return SUPPORTED_LOCALES.includes(language as Locale) ? (language as Locale) : "en";
}

let current: Locale = "en";
const listeners = new Set<() => void>();

/** What the device says, reduced to a language the app has. */
export function systemLocale(): Locale {
  const tag =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language
      : "en";
  return localeFromTag(tag);
}

/** The stored choice, "system" when nothing was chosen. */
export function localeChoice(): LocaleChoice {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "system" || SUPPORTED_LOCALES.includes(stored as Locale)) {
      return stored as LocaleChoice;
    }
  } catch {
    // No storage (a preview page, a locked-down webview): the system decides.
  }
  return "system";
}

export function resolveLocale(choice: LocaleChoice): Locale {
  return choice === "system" ? systemLocale() : choice;
}

/** The language the app shows right now. */
export function currentLocale(): Locale {
  return current;
}

/**
 * Apply a choice: store it and switch. Copy built at module scope (a table
 * of labels, the welcome page's points) was translated when its module
 * loaded and does not follow a switch, so the settings that offer the
 * choice reload the page after calling this; the root's re-render covers
 * everything that reads `t()` in render.
 */
export function setLocaleChoice(choice: LocaleChoice) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, choice);
  } catch {
    // Unstorable: the choice lasts this session.
  }
  applyLocale(resolveLocale(choice));
}

/** Store a choice, then reload so every sentence, module-scope ones included, follows. */
export function chooseLocaleAndReload(choice: LocaleChoice) {
  setLocaleChoice(choice);
  if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
    window.location.reload();
  }
}

/** The page says its language, so hyphenation, spelling and voices follow. */
function markDocument(locale: Locale) {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

/** Switch without storing (the root's boot, tests). */
export function applyLocale(locale: Locale) {
  if (locale === current) return;
  current = locale;
  markDocument(locale);
  for (const listener of listeners) listener();
}

/** Called once at boot, before the first render. */
export function initLocale() {
  current = resolveLocale(localeChoice());
  markDocument(current);
  return current;
}

export function onLocaleChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const INTL_TAGS: Record<Locale, string> = {
  en: "en-US",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  es: "es-ES",
  "pt-BR": "pt-BR",
};

/** A BCP 47 tag for `Intl` (dates, numbers, lists). */
export function intlLocale(): string {
  return INTL_TAGS[current];
}

type Vars = Record<string, string | number>;

function interpolate(text: string, vars?: Vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * The sentence in the current language. The English sentence is the key
 * and the fallback; `{name}` placeholders are filled from `vars`.
 */
export function t(source: string, vars?: Vars): string {
  const translated = catalogs[current][source];
  return interpolate(translated ?? source, vars);
}

/** The placeholders a sentence carries, for the catalog gate. */
export function placeholders(text: string): string[] {
  return Array.from(text.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort();
}
