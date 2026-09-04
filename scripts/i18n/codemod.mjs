#!/usr/bin/env node
/**
 * Wrap the copy of the React components in `t()` (ADR-0047).
 *
 *   node scripts/i18n/codemod.mjs            # report what it would do
 *   node scripts/i18n/codemod.mjs --write    # do it
 *
 * Three shapes are rewritten:
 *
 * 1. A JSX text node that stands alone: `<p>Export as PDF</p>` becomes
 *    `<p>{t("Export as PDF")}</p>`.
 * 2. A run of JSX text and simple expressions: `<p>Saved {count} notes</p>`
 *    becomes `<p>{t("Saved {count} notes", { count })}</p>`. An expression
 *    that is not a plain name (a call, a ternary, an element) leaves the
 *    run alone and is listed for a hand pass.
 * 3. A string attribute that carries copy (`aria-label`, `title`,
 *    `placeholder`, `label`, `description`…): `title="Stop"` becomes
 *    `title={t("Stop")}`.
 *
 * Text inside <code>, <kbd> and <pre> is left as it is; so is text with
 * fewer than two letters (a glyph, a shortcut, a number).
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const WRITE = process.argv.includes("--write");
const ROOTS = ["src/components", "src/app"];
const COPY_ATTRS = new Set([
  "aria-label",
  "aria-description",
  "ariaLabel",
  "label",
  "title",
  "placeholder",
  "description",
  "hint",
  "confirmLabel",
  "cancelLabel",
  "continueLabel",
  "backLabel",
  "addLabel",
  "body",
  "footer",
  "alt",
  "empty",
  "detail",
  "subtitle",
  "meta",
  "tip",
  "legend",
  "note",
  "valuePlaceholder",
  "keyPlaceholder",
  "message",
  "eyebrow",
]);
const LITERAL_TAGS = new Set(["code", "kbd", "pre", "samp"]);
const ENTITIES = {
  "&apos;": "'",
  "&#39;": "'",
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&hellip;": "…",
  "&mdash;": "—",
  "&ndash;": "–",
  "&middot;": "·",
  "&times;": "×",
  "&rarr;": "→",
  "&larr;": "←",
};

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) files.push(path);
  }
}
ROOTS.forEach(walk);

const stats = { files: 0, text: 0, runs: 0, attrs: 0, skipped: [] };

function decode(text) {
  return text.replace(/&[#\w]+;/g, (entity) => ENTITIES[entity] ?? entity);
}

function hasCopy(text) {
  return /[A-Za-zÀ-ÿ]{2,}/.test(text);
}

function quote(text) {
  return JSON.stringify(text);
}

/** Collapse JSX whitespace the way React does: inner newlines become single spaces. */
function jsxCollapse(text) {
  return text
    .split("\n")
    .map((line, index, lines) => {
      let out = line;
      if (index > 0) out = out.replace(/^\s+/, "");
      if (index < lines.length - 1) out = out.replace(/\s+$/, "");
      return out;
    })
    .filter((line, index, lines) => line !== "" || (index !== 0 && index !== lines.length - 1))
    .join(" ")
    .replace(/\s+/g, " ");
}

function parentTag(node) {
  const parent = node.parent;
  if (!parent) return "";
  if (ts.isJsxElement(parent)) return parent.openingElement.tagName.getText();
  return "";
}

/** A `{expr}` we can name as a placeholder, or null. */
function placeholderName(expression) {
  if (!expression) return null;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    // `note.title` -> title; `items.length` -> count-ish name from the object
    const name = expression.name.text;
    if (name === "length") {
      const object = expression.expression;
      return ts.isIdentifier(object) ? `${object.text}Count` : "count";
    }
    return name;
  }
  if (ts.isNonNullExpression(expression)) return placeholderName(expression.expression);
  if (ts.isParenthesizedExpression(expression)) return placeholderName(expression.expression);
  return null;
}

function transform(file) {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const handledText = new Set();

  function visitChildrenRun(parent) {
    // Runs of JsxText/JsxExpression between element children.
    const children = parent.children;
    let run = [];
    const flush = () => {
      if (run.length === 0) return;
      const texts = run.filter((c) => ts.isJsxText(c));
      const exprs = run.filter((c) => ts.isJsxExpression(c));
      const copyTexts = texts.filter((c) => hasCopy(c.getFullText()));
      if (copyTexts.length === 0 || exprs.length === 0) {
        run = [];
        return;
      }
      // Build a template over the whole run.
      const names = new Map();
      let template = "";
      let ok = true;
      for (const child of run) {
        if (ts.isJsxText(child)) {
          template += decode(jsxCollapse(child.getFullText()));
        } else {
          const name = placeholderName(child.expression);
          if (!name || !child.expression) {
            ok = false;
            break;
          }
          let key = name;
          let suffix = 2;
          while (names.has(key) && names.get(key) !== child.expression.getText()) {
            key = `${name}${suffix++}`;
          }
          names.set(key, child.expression.getText());
          template += `{${key}}`;
        }
      }
      if (!ok) {
        const line = sf.getLineAndCharacterOfPosition(run[0].getStart()).line + 1;
        stats.skipped.push(`${file}:${line}`);
        for (const child of copyTexts) handledText.add(child);
        run = [];
        return;
      }
      const first = run[0];
      const last = run[run.length - 1];
      // Trim the run's outer whitespace so the JSX around it keeps its shape.
      const firstText = first.getFullText();
      const lastText = last.getFullText();
      const start =
        (ts.isJsxText(first) ? first.getFullStart() : first.getStart()) +
        (ts.isJsxText(first) ? firstText.length - firstText.trimStart().length : 0);
      const end =
        last.getEnd() - (ts.isJsxText(last) ? lastText.length - lastText.trimEnd().length : 0);
      const trimmed = template.trim();
      const vars = [...names.entries()]
        .map(([key, expr]) => (key === expr ? key : `${key}: ${expr}`))
        .join(", ");
      edits.push({ start, end, text: `{t(${quote(trimmed)}, { ${vars} })}` });
      stats.runs++;
      for (const child of texts) handledText.add(child);
      run = [];
    };
    for (const child of children) {
      if (ts.isJsxText(child) || ts.isJsxExpression(child)) {
        if (ts.isJsxText(child) && !child.getFullText().trim()) {
          // whitespace-only text splits nothing; keep it in the run
          run.push(child);
          continue;
        }
        run.push(child);
      } else {
        flush();
      }
    }
    flush();
  }

  function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const tag = ts.isJsxElement(node) ? node.openingElement.tagName.getText() : "";
      if (!LITERAL_TAGS.has(tag)) visitChildrenRun(node);
    }
    if (ts.isJsxText(node) && !handledText.has(node)) {
      const raw = node.getFullText();
      const collapsed = decode(jsxCollapse(raw)).trim();
      if (hasCopy(collapsed) && !LITERAL_TAGS.has(parentTag(node))) {
        const start = node.getFullStart() + (raw.length - raw.trimStart().length);
        const end = node.getEnd() - (raw.length - raw.trimEnd().length);
        edits.push({ start, end, text: `{t(${quote(collapsed)})}` });
        stats.text++;
      }
    }
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      COPY_ATTRS.has(node.name.getText())
    ) {
      const value = node.initializer.text;
      if (hasCopy(value)) {
        edits.push({
          start: node.initializer.getStart(),
          end: node.initializer.getEnd(),
          text: `{t(${quote(value)})}`,
        });
        stats.attrs++;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (edits.length === 0) return;
  stats.files++;
  if (!WRITE) return;
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  if (!/import \{[^}]*\bt\b[^}]*\} from "[^"]*\/lib\/i18n"/.test(out)) {
    let rel = relative(dirname(file), "src/lib/i18n").replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    const importLine = `import { t } from "${rel}";\n`;
    const firstImport = out.search(/^import /m);
    out =
      firstImport === -1
        ? importLine + out
        : out.slice(0, firstImport) + importLine + out.slice(firstImport);
  }
  writeFileSync(file, out);
}

for (const file of files) transform(file);
console.log(
  `${WRITE ? "rewrote" : "would rewrite"} ${stats.files} files: ${stats.text} texts, ${stats.runs} runs with variables, ${stats.attrs} attributes; ${stats.skipped.length} runs left for a hand pass`,
);
if (stats.skipped.length) console.log(stats.skipped.join("\n"));
