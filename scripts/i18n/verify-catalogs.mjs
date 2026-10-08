#!/usr/bin/env node
/**
 * The quality gate every translated catalog passes (ADR-0047).
 *
 *   node scripts/i18n/verify-catalogs.mjs        # every language, exit 1 on an error
 *   node scripts/i18n/verify-catalogs.mjs de     # one language
 *
 * Errors (the catalog test fails on them): a sentence missing or extra, an
 * empty translation, a placeholder set that differs from the English, an en
 * or em dash, a product name that did not survive, and a translation
 * identical to its English sentence when that sentence is longer than three
 * words (a sentence nobody translated) unless `untranslated-ok.json` lists
 * it for that language (a code sample, a name).
 *
 * Warnings (printed, never failing): a glossary term the English uses whose
 * agreed translation (one word, or the stems of its inflections) the
 * sentence does not carry. Inflection, compounds and
 * a rephrasing that drops the noun all make this a reading aid, not a gate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The languages with a catalog besides English, in picker order. */
export const TRANSLATED_LOCALES = ["fr", "de", "it", "es", "pt-BR"];

// Paths are the repository's, as in extract.mjs: the scripts and the tests
// run from its root.
function readJson(relative) {
  return JSON.parse(readFileSync(relative, "utf8"));
}

/** The `{name}` placeholders of a sentence, sorted. Mirrors `placeholders` in i18n.ts. */
export function placeholderSet(text) {
  return Array.from(text.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort();
}

/** Words that remain once placeholders and punctuation-only tokens are set aside. */
export function wordCount(text) {
  return text
    .replace(/\{\w+\}/g, " ")
    .split(/\s+/)
    .filter((token) => /\p{L}/u.test(token)).length;
}

const DASHES = /[–—]/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Checks one catalog against the English. `glossary` is the language's
 * `glossary.<lang>.json` (optional: French has none), `allowed` the
 * sentences that may stay as written. Pure.
 */
export function verifyCatalog(en, catalog, { glossary, allowed = [] } = {}) {
  const errors = [];
  const warnings = [];
  const sentences = Object.keys(en);
  const allowedSet = new Set(allowed);
  for (const sentence of sentences) {
    if (!(sentence in catalog)) {
      errors.push({ sentence, problem: "missing" });
      continue;
    }
    const value = catalog[sentence];
    if (typeof value !== "string" || value.trim() === "") {
      errors.push({ sentence, problem: "empty" });
      continue;
    }
    if (placeholderSet(sentence).join() !== placeholderSet(value).join()) {
      errors.push({ sentence, problem: "placeholders", value });
    }
    if (DASHES.test(value) && !DASHES.test(sentence)) {
      errors.push({ sentence, problem: "typographic dash", value });
    }
    if (value === sentence && wordCount(sentence) > 3 && !allowedSet.has(sentence)) {
      errors.push({ sentence, problem: "left in English", value });
    }
    for (const name of glossary?.keep ?? []) {
      const pattern = new RegExp(`(^|[^\\p{L}])${escapeRegExp(name)}([^\\p{L}]|$)`, "u");
      if (pattern.test(sentence) && !value.includes(name)) {
        errors.push({ sentence, problem: `product name ${name} lost`, value });
      }
    }
    // A placeholder named like a term ({model}) is not the term.
    const prose = sentence.replace(/\{\w+\}/g, " ");
    const lowered = value.toLowerCase();
    for (const [term, target] of Object.entries(glossary?.terms ?? {})) {
      // A term is one agreed word, or the stems its inflections share.
      const forms = Array.isArray(target) ? target : [target];
      const pattern = new RegExp(`\\b${escapeRegExp(term)}s?\\b`, "i");
      if (pattern.test(prose) && !forms.some((form) => lowered.includes(form.toLowerCase()))) {
        warnings.push({ sentence, problem: `glossary: ${term} -> ${forms.join(" | ")}`, value });
      }
    }
  }
  for (const sentence of Object.keys(catalog)) {
    if (!(sentence in en)) errors.push({ sentence, problem: "not in en.json" });
  }
  for (const sentence of allowedSet) {
    if (!(sentence in en)) errors.push({ sentence, problem: "allowed but not in en.json" });
  }
  return { errors, warnings };
}

/** Reads the files for one language and checks them. */
export function verifyLocale(locale) {
  const en = readJson("src/locales/en.json");
  const catalog = readJson(`src/locales/${locale}.json`);
  const allowedAll = readJson("scripts/i18n/untranslated-ok.json");
  let glossary;
  try {
    glossary = readJson(`scripts/i18n/glossary.${locale}.json`);
  } catch {
    glossary = undefined;
  }
  return verifyCatalog(en, catalog, { glossary, allowed: allowedAll[locale] ?? [] });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const asked = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const verbose = process.argv.includes("--warnings");
  let failed = false;
  for (const locale of asked.length ? asked : TRANSLATED_LOCALES) {
    const { errors, warnings } = verifyLocale(locale);
    console.log(`${locale}: ${errors.length} errors, ${warnings.length} glossary warnings`);
    for (const error of errors.slice(0, 50))
      console.log(
        `  error ${error.problem}: ${JSON.stringify(error.sentence)}${error.value ? ` -> ${JSON.stringify(error.value)}` : ""}`,
      );
    if (verbose)
      for (const warning of warnings)
        console.log(
          `  warn ${warning.problem}: ${JSON.stringify(warning.sentence)} -> ${JSON.stringify(warning.value)}`,
        );
    if (errors.length) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
