export type SiteLocale = "en" | "fr";

let language: SiteLocale = "en";
const preferenceKey = "subrosa:website-language";

export function setWebsiteLocale(locale: SiteLocale) {
  language = locale;
}

export function websiteLocale(): SiteLocale {
  return language;
}

export function savedWebsiteLocale(): SiteLocale | null {
  try {
    const saved = localStorage.getItem(preferenceKey);
    return saved === "en" || saved === "fr" ? saved : null;
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

export function initialWebsiteLocale(
  path: string,
  search = "",
  browserLanguage = "en",
): SiteLocale {
  if (path === "/fr" || path.startsWith("/fr/")) return "fr";
  const requested = new URLSearchParams(search).get("lang");
  if (requested === "en" || requested === "fr") return requested;
  return savedWebsiteLocale() ?? (browserLanguage.toLowerCase().startsWith("fr") ? "fr" : "en");
}

export function t(en: string, fr: string): string {
  return language === "fr" ? fr : en;
}
export function date(value: string) {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
export function number(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat(language, { maximumFractionDigits }).format(value);
}
