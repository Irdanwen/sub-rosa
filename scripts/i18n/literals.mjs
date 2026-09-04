#!/usr/bin/env node
/**
 * The copy that lives in TypeScript rather than JSX: a status sentence
 * handed to `setStatus`, a `label:` in a table of rows, an `"Untitled
 * note"` fallback. Same rules as the codemod (ADR-0047):
 *
 *   node scripts/i18n/literals.mjs            # report
 *   node scripts/i18n/literals.mjs --write    # rewrite
 *
 * Wrapped: a string literal that is the value of a property whose name
 * carries copy (`label`, `title`, `description`, …), or the first argument
 * of a call to a sink (`setStatus`, `setError`, …), when it holds at least
 * two letters and a space or a capital start. Template literals with
 * `${…}` are listed for a hand pass instead.
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const WRITE = process.argv.includes("--write");
const ROOTS = ["src/components", "src/app"];
const COPY_PROPS = new Set([
  "label",
  "title",
  "description",
  "subtitle",
  "hint",
  "note",
  "detail",
  "placeholder",
  "message",
  "body",
  "footer",
  "empty",
  "emptyTitle",
  "emptyDescription",
  "confirmLabel",
  "cancelLabel",
  "actionLabel",
  "buttonLabel",
  "summary",
  "caption",
  "eyebrow",
  "meta",
  "tip",
  "legend",
  "addLabel",
  "text",
  "heading",
  "lede",
  "prompt",
]);
const SINKS = new Set([
  "setStatus",
  "setError",
  "setMessage",
  "setNotice",
  "setBanner",
  "setToast",
  "setHint",
  "setWarning",
  "setFeedback",
  "announce",
  "toast",
]);

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) files.push(path);
  }
}
ROOTS.forEach(walk);

const stats = { files: 0, props: 0, sinks: 0, templates: [] };

function isCopy(text) {
  return (
    /[A-Za-zÀ-ÿ]{2,}/.test(text) &&
    (/\s/.test(text) || /^[A-Z]/.test(text)) &&
    !/^[A-Z_]+$/.test(text) &&
    !/^[a-z]+([A-Z][a-z]+)+$/.test(text) &&
    !/^(https?:|\/|\.|#|--|[a-z-]+:[a-z-]+)/.test(text)
  );
}

function insideT(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "t"
    )
      return true;
    current = current.parent;
  }
  return false;
}

function transform(file) {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const edits = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && COPY_PROPS.has(node.name.getText()) && !insideT(node)) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) && isCopy(init.text)) {
        edits.push({
          start: init.getStart(),
          end: init.getEnd(),
          text: `t(${JSON.stringify(init.text)})`,
        });
        stats.props++;
      } else if (ts.isTemplateExpression(init)) {
        stats.templates.push(
          `${file}:${sf.getLineAndCharacterOfPosition(init.getStart()).line + 1}`,
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      SINKS.has(node.expression.text) &&
      node.arguments.length >= 1
    ) {
      const first = node.arguments[0];
      if (ts.isStringLiteral(first) && isCopy(first.text)) {
        edits.push({
          start: first.getStart(),
          end: first.getEnd(),
          text: `t(${JSON.stringify(first.text)})`,
        });
        stats.sinks++;
      } else if (ts.isTemplateExpression(first)) {
        stats.templates.push(
          `${file}:${sf.getLineAndCharacterOfPosition(first.getStart()).line + 1}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
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
  `${WRITE ? "rewrote" : "would rewrite"} ${stats.files} files: ${stats.props} properties, ${stats.sinks} sink arguments; ${stats.templates.length} templates for a hand pass`,
);
if (stats.templates.length) console.log(stats.templates.join("\n"));
