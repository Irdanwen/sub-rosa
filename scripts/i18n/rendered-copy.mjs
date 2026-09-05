import ts from "typescript";

const COPY_ATTRIBUTES = new Set([
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

function isCopy(value) {
  const text = value.trim();
  return (
    /[A-Za-zÀ-ÿ]{2,}/.test(text) &&
    !/^(https?:|data:|\/|\.\.?\/|#[\w-]|--[\w-])/.test(text) &&
    !/^[a-z0-9]+(?:[-_:./][a-z0-9]+)+$/.test(text) &&
    !/^[a-z]+(?:[A-Z][a-z0-9]+)+$/.test(text) &&
    !/^(?:true|false|null|undefined)$/.test(text)
  );
}

/** Inspect only expressions whose value reaches a copy-bearing surface.
 * A ternary's condition and a function's arguments are not rendered copy.
 * Following these branches catches nested conditionals without accidentally
 * translating model IDs, class names, event handlers or status comparisons. */
export function findRenderedCopy(source, fileName = "component.tsx") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map();
  function report(node, text) {
    if (!isCopy(text)) return;
    found.set(node.getStart(), {
      text,
      start: node.getStart(),
      end: node.getEnd(),
      line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    });
  }
  function output(node) {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      report(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      report(node, node.head.text + node.templateSpans.map((span) => span.literal.text).join(" "));
      for (const span of node.templateSpans) output(span.expression);
    } else if (ts.isConditionalExpression(node)) {
      output(node.whenTrue);
      output(node.whenFalse);
    } else if (ts.isParenthesizedExpression(node)) output(node.expression);
    else if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken) {
        output(node.left);
        output(node.right);
      } else if (kind === ts.SyntaxKind.AmpersandAmpersandToken) output(node.right);
    }
  }
  function visit(node) {
    if (ts.isJsxElement(node) && LITERAL_TAGS.has(node.openingElement.tagName.getText(sf))) return;
    if (ts.isJsxText(node)) report(node, node.text.replace(/\s+/g, " ").trim());
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) output(node.expression);
    if (ts.isJsxAttribute(node) && COPY_ATTRIBUTES.has(node.name.getText(sf))) {
      const init = node.initializer;
      if (init && ts.isJsxExpression(init)) output(init.expression);
      else if (init && ts.isStringLiteral(init)) report(init, init.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return [...found.values()];
}
