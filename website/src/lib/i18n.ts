// The website is English-only, independently of the apps and browser settings.
// Keep the translation seam so existing account messages retain one copy path.
const language = "en";
export function t(en: string, _fr: string): string {
  return en;
}
export function date(value: string) {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
export function number(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat(language, { maximumFractionDigits }).format(value);
}
