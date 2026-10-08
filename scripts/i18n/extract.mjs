#!/usr/bin/env node
/**
 * Collect every `t("…")` source sentence and keep the catalogs in step.
 *
 *   node scripts/i18n/extract.mjs          # update src/locales/*.json
 *   node scripts/i18n/extract.mjs --check  # fail if a catalog is behind
 *
 * `en.json` lists the sentences (the key is the sentence). Every translated
 * catalog (`fr.json`, `de.json`, `it.json`, `es.json`, `pt-BR.json`) keeps
 * its translations, gains a "" for every new sentence, and loses the ones
 * no code says any more. The gate test refuses an empty translation, so a
 * new sentence is a red test until it is translated in every language
 * (ADR-0047). `--check` also runs `verify-catalogs.mjs` (placeholders,
 * dashes, sentences left in English).
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { collectRustSentences } from "./rust-sentences.mjs";
import { TRANSLATED_LOCALES, verifyLocale } from "./verify-catalogs.mjs";

const CHECK = process.argv.includes("--check");
const ROOTS = ["src"];
const LOCALES = TRANSLATED_LOCALES;

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "test" || name === "locales") continue;
      walk(path);
    } else if (/\.(tsx?|mts)$/.test(name) && !/\.test\./.test(name) && !/\.d\.ts$/.test(name)) {
      files.push(path);
    }
  }
}
ROOTS.forEach(walk);

const sentences = new Map(); // sentence -> first file
for (const file of files) {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "t" &&
      node.arguments.length >= 1
    ) {
      const first = node.arguments[0];
      if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
        if (!sentences.has(first.text)) sentences.set(first.text, file);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// The backend's own sentences: AppError literals reach the screen through
// messageFromError, which passes them through t(), and tr!() literals are
// rendered by Rust itself from this catalog. Collected fresh from the Rust
// source and kept in backend-messages.json, which the check holds to it.
const backendPath = "src/locales/backend-messages.json";
const backend = collectRustSentences();
for (const sentence of backend) {
  if (!sentences.has(sentence)) sentences.set(sentence, backendPath);
}
const backendJson = `${JSON.stringify(backend, null, 2)}\n`;
const backendStale = !existsSync(backendPath) || readFileSync(backendPath, "utf8") !== backendJson;
const keys = [...sentences.keys()].sort((a, b) => a.localeCompare(b, "en"));
const en = Object.fromEntries(keys.map((key) => [key, key]));
let behind = 0;
const behindBy = {};
const outputs = { "src/locales/en.json": en };
for (const locale of LOCALES) {
  const path = `src/locales/${locale}.json`;
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const next = {};
  for (const key of keys) {
    next[key] = current[key] ?? "";
    if (!next[key]) {
      behind++;
      behindBy[locale] = (behindBy[locale] ?? 0) + 1;
    }
  }
  outputs[path] = next;
}
if (CHECK) {
  const enPath = "src/locales/en.json";
  const currentEn = existsSync(enPath) ? JSON.parse(readFileSync(enPath, "utf8")) : {};
  const stale =
    keys.filter((key) => !(key in currentEn)).length +
    Object.keys(currentEn).filter((key) => !sentences.has(key)).length;
  const untranslated = Object.entries(behindBy)
    .map(([locale, count]) => `${locale} ${count}`)
    .join(", ");
  console.log(
    `${keys.length} sentences; ${behind} untranslated${untranslated ? ` (${untranslated})` : ""}; ${stale} not in en.json${backendStale ? "; backend-messages.json is behind the Rust source" : ""}`,
  );
  // The quality gate only means something once the catalogs hold every
  // sentence; until then the counts above say what is missing.
  let invalid = 0;
  if (stale === 0 && behind === 0) {
    for (const locale of LOCALES) {
      const { errors } = verifyLocale(locale);
      for (const error of errors.slice(0, 20)) {
        console.log(`${locale}: ${error.problem}: ${JSON.stringify(error.sentence)}`);
      }
      invalid += errors.length;
    }
  }
  process.exit(stale === 0 && behind === 0 && invalid === 0 && !backendStale ? 0 : 1);
}
outputs[backendPath] = backend;
for (const [path, value] of Object.entries(outputs)) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
console.log(
  `${keys.length} sentences in ${files.length} files; ${behind} untranslated${
    Object.keys(behindBy).length
      ? ` (${Object.entries(behindBy)
          .map(([locale, count]) => `${locale} ${count}`)
          .join(", ")})`
      : ""
  }`,
);
