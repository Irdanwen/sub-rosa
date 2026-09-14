import { useSyncExternalStore } from "react";

export type Language = "fr" | "en";
let language: Language =
  typeof navigator !== "undefined" && !navigator.language.startsWith("fr") ? "en" : "fr";
try {
  const saved = localStorage.getItem("subrosa:site-language");
  if (saved === "fr" || saved === "en") language = saved;
} catch {
  /* Private browsing can disable storage. */
}
const listeners = new Set<() => void>();
export function setLanguage(value: Language) {
  language = value;
  try {
    localStorage.setItem("subrosa:site-language", value);
  } catch {
    /* Optional preference. */
  }
  if (typeof document !== "undefined") document.documentElement.lang = value;
  for (const listener of listeners) listener();
}
export function useLanguage() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => language,
    () => language,
  );
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
