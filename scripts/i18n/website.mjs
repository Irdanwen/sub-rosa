#!/usr/bin/env node
/**
 * The website in six languages (ADR-0047, website addendum).
 *
 *   node scripts/i18n/website.mjs          # update website/src/locales/**
 *   node scripts/i18n/website.mjs --check  # fail if a catalog is behind
 *
 * The website writes its copy as pairs, `t("English", "Français")` and
 * `Copy` data `[en, fr]`, so English and French live in the code. The four
 * other languages live in catalogs keyed by the English sentence, the way
 * the app's do, and `t` reads them at run time. This script finds every
 * English sentence the site can show:
 *
 * - the first argument of every `t(…)` call: a literal, both branches of a
 *   conditional, a template (its `${…}` become `{name}` placeholders, which
 *   the run time matches back), or a constant whose type is a literal;
 * - every two-string array whose type is `Copy` (TypeScript data);
 * - the `Copy` fields of the model catalog's JSON (`COPY_FIELDS`);
 * - the few sentences that arrive through a variable (`RESOLVERS`).
 *
 * A `t(…)` whose English it cannot find is a problem, so a new kind of call
 * site has to be taught here rather than silently left in English.
 *
 * Each sentence belongs to one catalog, loaded with the code that shows it:
 * `app` (the web client, `src/client/`), `models` (the model catalog),
 * `models:<kind>` (a kind's family depth, with its detail chunk) or `site`
 * (everything else, and any sentence two of them share).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { verifyCatalog } from "./verify-catalogs.mjs";

/** The languages with a website catalog: French is written in the code. */
export const WEBSITE_LOCALES = ["de", "it", "es", "pt-BR"];
const DETAIL_KINDS = readdirSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../website/src/models/details"),
)
  .filter((name) => name.endsWith(".json") && name !== "index.json")
  .map((name) => name.slice(0, -5))
  .sort();
/** `models:<kind>` is a family's depth, loaded with its detail chunk. */
export const PARTS = ["site", "app", "models", ...DETAIL_KINDS.map((kind) => `models:${kind}`)];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(ROOT, "website/src");
const LOCALES_DIR = join(SRC, "locales");

export const catalogPath = (part, locale) =>
  join(LOCALES_DIR, part === "site" ? "" : part.replace(":", "/"), `${locale}.json`);

const rel = (path) => relative(ROOT, path).split("\\").join("/");

function partOf(file) {
  const path = rel(file);
  if (path.startsWith("website/src/client/") || path === "website/src/pages/web-app.tsx")
    return "app";
  if (path.startsWith("website/src/models/") || path.startsWith("website/src/pages/models/"))
    return "models";
  return "site";
}

const partOfJson = (file) => {
  const detail = file.match(/models\/details\/(\w+)\.json$/);
  return detail ? `models:${detail[1]}` : "models";
};

/** The `Copy` fields of the catalog's JSON, as paths (`[]` walks an array). */
const DETAIL_FIELDS = [
  ".families[].strengths[]",
  ".families[].limits[]",
  ".families[].facts[]",
  ".families[].differentiator",
  ".families[].signature[]",
  ".families[].releases[].changes[]",
  ".families[].specs[].languages",
  ".families[].useCases[].title",
  ".families[].useCases[].prompt",
  ".families[].useCases[].why",
  ".families[].rivals[].verdict",
];
export const COPY_FIELDS = {
  "website/src/models/families.json": ["[].summary", "[].variants[].note"],
  "website/src/models/benchmarks.json": [".benchmarks[].measures", ".benchmarks[].howToRead"],
  ...Object.fromEntries(
    readdirSync(join(SRC, "models/details"))
      .filter((name) => name.endsWith(".json") && name !== "index.json")
      .map((name) => [`website/src/models/details/${name}`, DETAIL_FIELDS]),
  ),
};

/**
 * Sentences that reach `t` through a variable, by the text of the argument.
 * Each returns `[en, fr, file]` triples.
 */
const RESOLVERS = {
  // Protected mode's refusals are Rust's words (chat-core's protected.json).
  "PROTECTED.refusals.": (argument) => {
    const key = argument.split(".").pop();
    const exported = JSON.parse(
      readFileSync(join(ROOT, "packages/chat-core/web/protected.json"), "utf8"),
    );
    const en = exported.refusals?.[key];
    return en ? [[en, null, "website/src/client/protected/rules.ts"]] : [];
  },
  // A family's name is translated only where it describes rather than names.
  "family.name": () =>
    JSON.parse(readFileSync(join(SRC, "models/families.json"), "utf8"))
      .filter((family) => family.nameFr)
      .map((family) => [family.name, family.nameFr, "website/src/models/families.json"]),
  // Pairs handed to `t` as variables: the pairs themselves are collected as data.
  en: () => [],
};

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "locales") sourceFiles(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const PLACEHOLDER_RENAMES = { length: "count", t: "text", read: "text" };

function placeholderName(expression, used) {
  let node = expression;
  let name = "value";
  for (let depth = 0; depth < 8; depth++) {
    if (ts.isIdentifier(node)) {
      name = node.text;
      break;
    }
    if (ts.isPropertyAccessExpression(node)) {
      name = node.name.text;
      break;
    }
    if (ts.isCallExpression(node) || ts.isElementAccessExpression(node)) {
      node = node.expression;
      continue;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      node = node.expression;
      continue;
    }
    if (ts.isBinaryExpression(node)) {
      node = node.left;
      continue;
    }
    if (ts.isConditionalExpression(node)) {
      node = node.whenTrue;
      continue;
    }
    break;
  }
  name = PLACEHOLDER_RENAMES[name] ?? name;
  if (!/^\w+$/.test(name)) name = "value";
  let unique = name;
  for (let index = 2; used.has(unique); index++) unique = `${name}${index}`;
  used.add(unique);
  return unique;
}

/** A template's English with `{name}` for each `${…}`. */
function templateText(node) {
  const used = new Set();
  let text = node.head.text;
  for (const span of node.templateSpans)
    text += `{${placeholderName(span.expression, used)}}${span.literal.text}`;
  return text;
}

/**
 * The sentences an expression can evaluate to, or null when it cannot tell.
 * `templated` marks a sentence built from a template.
 */
function texts(node, checker) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [{ text: node.text, templated: false }];
  if (ts.isTemplateExpression(node)) return [{ text: templateText(node), templated: true }];
  if (ts.isParenthesizedExpression(node)) return texts(node.expression, checker);
  if (ts.isConditionalExpression(node)) {
    const a = texts(node.whenTrue, checker);
    const b = texts(node.whenFalse, checker);
    return a && b ? [...a, ...b] : null;
  }
  // `.replace(…)`, `.trim()` on a sentence: the sentence is the key.
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ["replace", "trim"].includes(node.expression.name.text)
  )
    return texts(node.expression.expression, checker);
  if (checker) {
    const type = checker.getTypeAtLocation(node);
    const members = type.isUnion() ? type.types : [type];
    if (members.length && members.every((member) => member.isStringLiteral()))
      return members.map((member) => ({ text: member.value, templated: false }));
  }
  return null;
}

function isCopyType(type, checker) {
  if (!type) return false;
  if (type.aliasSymbol?.name === "Copy") return true;
  if (type.isUnion()) return type.types.some((member) => isCopyType(member, checker));
  if (checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type);
    return (
      args.length === 2 &&
      args.every((arg) => arg.flags & ts.TypeFlags.String) &&
      // Only a pair of words is copy; a tuple of two other strings is data.
      type.target?.labeledElementDeclarations?.[0]?.name?.getText() === "en"
    );
  }
  return false;
}

function walkJson(value, path, visit) {
  const [head, ...rest] = path;
  if (head === undefined) return visit(value);
  if (head === "[]") {
    if (Array.isArray(value)) for (const item of value) walkJson(item, rest, visit);
    return;
  }
  if (value && typeof value === "object" && head in value) walkJson(value[head], rest, visit);
}

const splitPath = (path) => path.match(/\[\]|[^.[\]]+/g) ?? [];

/**
 * Every English sentence the website can show, with the French the code
 * pairs it with and the catalog it belongs to.
 */
export function collectWebsiteSentences() {
  const files = sourceFiles(SRC);
  const config = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, "website/tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  const program = ts.createProgram(files, { ...config.options, noEmit: true });
  const checker = program.getTypeChecker();
  /** @type {Map<string, {fr: Set<string>, parts: Set<string>, files: Set<string>, templated: boolean}>} */
  const sentences = new Map();
  const problems = [];
  const add = (en, fr, file, part, templated = false) => {
    if (!en.trim()) return;
    const entry = sentences.get(en) ?? {
      fr: new Set(),
      parts: new Set(),
      files: new Set(),
      templated,
    };
    if (fr != null) entry.fr.add(fr);
    entry.parts.add(part);
    entry.files.add(file);
    entry.templated ||= templated;
    sentences.set(en, entry);
  };

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const part = partOf(file);
    const name = rel(file);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t" &&
        node.arguments.length === 2
      ) {
        const [first, second] = node.arguments;
        const en = texts(first, checker);
        const fr = texts(second, null);
        if (en) {
          en.forEach((item, index) => {
            const french = fr && fr.length === en.length ? fr[index].text : null;
            add(item.text, french, name, part, item.templated);
          });
        } else {
          const argument = first.getText(source);
          const resolver = Object.entries(RESOLVERS).find(([prefix]) =>
            argument.startsWith(prefix),
          )?.[1];
          if (resolver) {
            for (const [text, french, origin] of resolver(argument))
              add(text, french, origin, partOf(join(ROOT, origin)));
          } else {
            const { line } = source.getLineAndCharacterOfPosition(first.getStart(source));
            problems.push(
              `${name}:${line + 1}: t(${argument}, …) has no English the extractor can find`,
            );
          }
        }
      }
      if (ts.isArrayLiteralExpression(node) && node.elements.length === 2) {
        const [first, second] = node.elements;
        const en = texts(first, null);
        const fr = texts(second, null);
        if (
          en?.length === 1 &&
          fr?.length === 1 &&
          isCopyType(checker.getContextualType(node), checker)
        )
          add(en[0].text, fr[0].text, name, part, en[0].templated);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  for (const [file, fields] of Object.entries(COPY_FIELDS)) {
    const data = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
    for (const field of fields)
      walkJson(data, splitPath(field), (copy) => {
        if (Array.isArray(copy) && copy.length === 2 && copy.every((x) => typeof x === "string"))
          add(copy[0], copy[1], file, partOfJson(file));
        else if (copy !== null) problems.push(`${file}: ${field} is not a [en, fr] pair`);
      });
  }

  // A sentence French reads two ways ("Back": "Retour", "Verso") gets a key
  // per reading, which `t` tries before the bare sentence.
  const byPart = Object.fromEntries(PARTS.map((part) => [part, []]));
  for (const [en, entry] of [...sentences]) {
    const parts = [...entry.parts];
    const part =
      parts.length === 1
        ? parts[0]
        : parts.every((name) => name.startsWith("models"))
          ? "models"
          : "site";
    if (entry.fr.size > 1 && !entry.templated)
      for (const fr of entry.fr) {
        const key = `${en} [fr: ${fr}]`;
        byPart[part].push(key);
        sentences.set(key, { ...entry, fr: new Set([fr]) });
      }
    else byPart[part].push(en);
  }
  for (const part of PARTS) byPart[part].sort((a, b) => a.localeCompare(b, "en"));
  return { sentences, byPart, problems };
}

/**
 * Sentences that stay as written in every language: a prompt for a voice
 * that speaks only English.
 */
const AS_WRITTEN = new Set([
  "Tara: <laugh> You really did that? Leo: <sigh> Yes, and I regret it.",
]);

/** Sentences the code leaves identical in French may stay identical everywhere. */
function identicalInFrench(sentences, keys) {
  return keys.filter((key) => {
    if (AS_WRITTEN.has(key)) return true;
    const fr = sentences.get(key)?.fr;
    return fr && fr.size > 0 && [...fr].every((value) => value === key);
  });
}

function readCatalog(part, locale) {
  const path = catalogPath(part, locale);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

/** Checks every website catalog against the code. Pure apart from reading files. */
export function verifyWebsiteCatalogs(collected = collectWebsiteSentences()) {
  const { sentences, byPart, problems } = collected;
  const errors = problems.map((problem) => ({ locale: "*", part: "*", problem }));
  const warnings = [];
  for (const locale of WEBSITE_LOCALES) {
    let glossary;
    try {
      glossary = JSON.parse(
        readFileSync(join(ROOT, `scripts/i18n/glossary.${locale}.json`), "utf8"),
      );
    } catch {
      glossary = undefined;
    }
    for (const part of PARTS) {
      const keys = byPart[part];
      const en = Object.fromEntries(keys.map((key) => [key, key]));
      const result = verifyCatalog(en, readCatalog(part, locale), {
        glossary,
        allowed: identicalInFrench(sentences, keys),
      });
      for (const error of result.errors) errors.push({ locale, part, ...error });
      for (const warning of result.warnings) warnings.push({ locale, part, ...warning });
    }
  }
  return { errors, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const collected = collectWebsiteSentences();
  const { byPart, problems } = collected;
  for (const problem of problems) console.log(problem);
  const total = PARTS.reduce((sum, part) => sum + byPart[part].length, 0);
  const behind = {};
  for (const locale of WEBSITE_LOCALES)
    for (const part of PARTS) {
      const current = readCatalog(part, locale);
      const next = Object.fromEntries(byPart[part].map((key) => [key, current[key] ?? ""]));
      const missing = Object.values(next).filter((value) => !value).length;
      if (missing) behind[locale] = (behind[locale] ?? 0) + missing;
      if (!check) {
        mkdirSync(dirname(catalogPath(part, locale)), { recursive: true });
        writeFileSync(catalogPath(part, locale), `${JSON.stringify(next, null, 2)}\n`);
      }
    }
  const summary = Object.entries(behind)
    .map(([locale, count]) => `${locale} ${count}`)
    .join(", ");
  console.log(
    `${total} sentences (${PARTS.map((part) => `${part} ${byPart[part].length}`).join(", ")}); untranslated: ${summary || "none"}`,
  );
  if (check) {
    const { errors } = verifyWebsiteCatalogs(collected);
    for (const error of errors.slice(0, 40))
      console.log(
        `${error.locale}/${error.part}: ${error.problem}: ${JSON.stringify(error.sentence ?? "")}`,
      );
    process.exit(errors.length || problems.length ? 1 : 0);
  }
}
