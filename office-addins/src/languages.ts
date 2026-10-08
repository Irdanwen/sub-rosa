import { websiteLocale } from "../../website/src/lib/i18n";

/** The languages a passage can be translated into, by code. */
export const TARGET_LANGUAGES = ["en", "fr", "de", "it", "es", "pt", "nl", "ja", "zh"] as const;

/** A language's name in English, which is how the rewrite prompt names it. */
export function promptLanguageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A language's name in the pane's own language. */
export function shownLanguageName(code: string): string {
  try {
    return new Intl.DisplayNames([websiteLocale()], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
