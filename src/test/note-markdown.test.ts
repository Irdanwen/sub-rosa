import { getSchema } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { noteSchemaExtensions } from "../components/note-editor/extensions";
import { docToMarkdown, markdownToDoc } from "../lib/note-markdown";

/**
 * The gate for the note body's markdown seam.
 *
 * The property that matters is not "markdown normalizes" but **a document the
 * editor can hold survives being written to the file and read back**. Every
 * silent-loss bug this suite exists to prevent — flattened nesting, headings
 * collapsed to level 1, a paragraph reading `- x` coming back as a list — is a
 * violation of exactly that.
 */

const schema = getSchema(noteSchemaExtensions());

function docFrom(json: unknown): ProseMirrorNode {
  return schema.nodeFromJSON(json);
}

/** parse -> serialize -> parse, as JSON, for comparison against the original. */
function roundTripJson(json: unknown) {
  const markdown = docToMarkdown(docFrom(json));
  return { markdown, json: docFrom(markdownToDoc(markdown)).toJSON() };
}

function paragraph(...content: unknown[]) {
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}
function text(value: string, ...marks: string[]) {
  return marks.length
    ? { type: "text", text: value, marks: marks.map((type) => ({ type })) }
    : { type: "text", text: value };
}
function doc(...content: unknown[]) {
  return { type: "doc", content };
}
function item(...content: unknown[]) {
  return { type: "listItem", content };
}

/* ------------------------------------------------------------------ *
 * The regressions this replaces
 * ------------------------------------------------------------------ */

describe("what the previous converter destroyed", () => {
  it("keeps nested bullets nested", () => {
    const markdown = "- one\n  - nested\n    - deeper\n- two";
    expect(docToMarkdown(docFrom(markdownToDoc(markdown)))).toBe(markdown);
  });

  it("keeps heading levels apart instead of flattening them to one", () => {
    const markdown = "# One\n\n## Two\n\n### Three";
    const parsed = markdownToDoc(markdown) as { content: { attrs: { level: number } }[] };
    expect(parsed.content.map((node) => node.attrs.level)).toEqual([1, 2, 3]);
    expect(docToMarkdown(docFrom(parsed))).toBe(markdown);
  });

  it("clamps a heading deeper than the note styles define", () => {
    const parsed = markdownToDoc("##### Deep") as { content: { attrs: { level: number } }[] };
    expect(parsed.content[0].attrs.level).toBe(3);
  });

  it("keeps an ordered list ordered", () => {
    const markdown = "1. first\n2. second\n3. third";
    expect(docToMarkdown(docFrom(markdownToDoc(markdown)))).toBe(markdown);
  });

  it("keeps a paragraph that merely looks like a list a paragraph", () => {
    const { markdown, json } = roundTripJson(doc(paragraph(text("- not a list"))));
    expect(markdown).toBe("\\- not a list");
    expect(json).toEqual(doc(paragraph(text("- not a list"))));
  });

  it("keeps a paragraph that merely looks like a heading a paragraph", () => {
    const { json } = roundTripJson(doc(paragraph(text("# not a heading"))));
    expect(json).toEqual(doc(paragraph(text("# not a heading"))));
  });

  it("keeps a task list, with each box in the state it was in", () => {
    const markdown = "- [ ] not done\n- [x] done\n  - [ ] a nested one";
    expect(docToMarkdown(docFrom(markdownToDoc(markdown)))).toBe(markdown);
  });

  it("keeps a highlight", () => {
    const markdown = "Some ==highlighted== text.";
    expect(docToMarkdown(docFrom(markdownToDoc(markdown)))).toBe(markdown);
  });

  it("keeps quotes, rules, code blocks and strikes", () => {
    const markdown = "> quoted\n\n---\n\n```ts\nconst a = 1;\n```\n\ndone";
    expect(docToMarkdown(docFrom(markdownToDoc(markdown)))).toBe(markdown);
  });
});

/* ------------------------------------------------------------------ *
 * P1 — a document survives serialization (the property that matters)
 * ------------------------------------------------------------------ */

const DOC_CORPUS: { name: string; json: ReturnType<typeof doc> }[] = [
  { name: "empty", json: doc(paragraph()) },
  { name: "plain paragraph", json: doc(paragraph(text("Hello there."))) },
  {
    name: "every mark",
    json: doc(
      paragraph(
        text("plain "),
        text("bold", "bold"),
        text(" "),
        text("italic", "italic"),
        text(" "),
        text("struck", "strike"),
        text(" "),
        text("code()", "code"),
      ),
    ),
  },
  {
    name: "bold and italic at once",
    json: doc(paragraph(text("a "), text("both", "bold", "italic"), text(" b"))),
  },
  {
    name: "adjacent runs with different marks",
    json: doc(paragraph(text("abc", "italic"), text("def", "bold", "italic"), text("ghi", "bold"))),
  },
  {
    name: "code containing backticks",
    json: doc(paragraph(text("use "), text("a `b` c", "code"))),
  },
  {
    name: "link",
    json: doc(
      paragraph(
        text("see "),
        {
          type: "text",
          text: "the docs",
          marks: [{ type: "link", attrs: { href: "https://example.com/a(b)" } }],
        },
        text(" now"),
      ),
    ),
  },
  {
    name: "link with a space in the target",
    json: doc(
      paragraph({
        type: "text",
        text: "x",
        marks: [{ type: "link", attrs: { href: "https://example.com/a b" } }],
      }),
    ),
  },
  {
    name: "bold link",
    json: doc(
      paragraph({
        type: "text",
        text: "strong link",
        marks: [{ type: "link", attrs: { href: "https://example.com/" } }, { type: "bold" }],
      }),
    ),
  },
  {
    name: "headings at every level",
    json: doc(
      { type: "heading", attrs: { level: 1 }, content: [text("One")] },
      { type: "heading", attrs: { level: 2 }, content: [text("Two")] },
      { type: "heading", attrs: { level: 3 }, content: [text("Three")] },
    ),
  },
  {
    name: "nested bullet lists",
    json: doc({
      type: "bulletList",
      content: [
        item(paragraph(text("one")), {
          type: "bulletList",
          content: [item(paragraph(text("nested")))],
        }),
        item(paragraph(text("two"))),
      ],
    }),
  },
  {
    name: "ordered list starting at three",
    json: doc({
      type: "orderedList",
      attrs: { start: 3 },
      content: [item(paragraph(text("third"))), item(paragraph(text("fourth")))],
    }),
  },
  {
    name: "ordered list inside a bullet",
    json: doc({
      type: "bulletList",
      content: [
        item(paragraph(text("outer")), {
          type: "orderedList",
          attrs: { start: 1 },
          content: [item(paragraph(text("inner")))],
        }),
      ],
    }),
  },
  {
    name: "task list, mixed states",
    json: doc({
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: false }, content: [paragraph(text("open"))] },
        { type: "taskItem", attrs: { checked: true }, content: [paragraph(text("done"))] },
      ],
    }),
  },
  {
    name: "task list nested in a task list",
    json: doc({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [
            paragraph(text("outer")),
            {
              type: "taskList",
              content: [
                {
                  type: "taskItem",
                  attrs: { checked: true },
                  content: [paragraph(text("inner"))],
                },
              ],
            },
          ],
        },
      ],
    }),
  },
  {
    name: "bullet list holding a task list",
    json: doc({
      type: "bulletList",
      content: [
        item(paragraph(text("plan")), {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: false }, content: [paragraph(text("step"))] },
          ],
        }),
      ],
    }),
  },
  {
    name: "highlight, alone and with other marks",
    json: doc(
      paragraph(
        text("a "),
        text("marked", "highlight"),
        text(" "),
        text("both", "highlight", "bold"),
        text(" b"),
      ),
    ),
  },
  {
    name: "text containing equals signs",
    json: doc(paragraph(text("a = b and c == d and ===="))),
  },
  {
    name: "list item with two paragraphs",
    json: doc({
      type: "bulletList",
      content: [item(paragraph(text("first")), paragraph(text("second")))],
    }),
  },
  {
    name: "blockquote with a list",
    json: doc({
      type: "blockquote",
      content: [
        paragraph(text("quoted")),
        { type: "bulletList", content: [item(paragraph(text("point")))] },
      ],
    }),
  },
  {
    name: "code block with a language",
    json: doc({
      type: "codeBlock",
      attrs: { language: "rust" },
      content: [text('let x = "hi";\nlet y = 2;')],
    }),
  },
  {
    name: "code block containing a fence",
    json: doc({
      type: "codeBlock",
      attrs: { language: null },
      content: [text("```\nnested\n```")],
    }),
  },
  {
    name: "horizontal rule",
    json: doc(paragraph(text("a")), { type: "horizontalRule" }, paragraph(text("b"))),
  },
  {
    name: "hard break",
    json: doc(paragraph(text("first line"), { type: "hardBreak" }, text("second line"))),
  },
  {
    name: "hard break followed by a list marker",
    json: doc(paragraph(text("first"), { type: "hardBreak" }, text("- second"))),
  },
  {
    name: "text full of markdown specials",
    json: doc(paragraph(text("a*b_c`d~e[f]g\\h #i >j -k 1.l"))),
  },
  {
    name: "intra-word underscores",
    json: doc(paragraph(text("call snake_case_name twice"))),
  },
  {
    name: "unmatched delimiters",
    json: doc(paragraph(text("2 ** 3 and ~ and * alone"))),
  },
  {
    name: "a markdown table stays literal text",
    json: doc(paragraph(text("| a | b |"), { type: "hardBreak" }, text("| - | - |"))),
  },
];

describe("a document survives being written and read back", () => {
  for (const entry of DOC_CORPUS) {
    it(entry.name, () => {
      const { json } = roundTripJson(entry.json);
      expect(json).toEqual(docFrom(entry.json).toJSON());
    });
  }
});

/* ------------------------------------------------------------------ *
 * P2 — one round trip normalizes, further ones change nothing
 * ------------------------------------------------------------------ */

const MARKDOWN_CORPUS = [
  "",
  "   ",
  "# Title\n\nA paragraph with **bold**, *italic* and `code`.",
  "* star bullet\n+ plus bullet",
  "1) paren ordered\n2) second",
  "- a\n\n- b",
  "> quote\n> continued\n\nafter",
  "Text with a [link](https://example.com) inside.",
  "| a | b |\n| - | - |\n| 1 | 2 |",
  "<div>raw html</div>",
  "Line one\nLine two\nLine three",
  "***both***",
  "~~struck~~ and ~single~",
  "  - indented start\n    - deeper",
  "#### too deep\n\n###### far too deep",
  "```\nplain fence\n```",
  "---\n\n***\n\n___",
  "Trailing spaces   \nnext line",
  "1. one\n   continued in the item\n2. two",
  "- item\n\n  second paragraph of the item\n\n- next item",
  "A line ending in a backslash \\\nand the next",
  "**unclosed bold and *unclosed italic",
  "[not a link](  )",
  "Footnote-ish [^1] and an ![image](x.png)",
  "- [ ] todo\n- [X] done\n- plain bullet",
  "- plain first\n- [ ] then a box",
  "==mark== and ==== and a = b",
  "1. [ ] a checkbox on an ordered item",
];

describe("markdown normalizes once and then holds still", () => {
  for (const source of MARKDOWN_CORPUS) {
    it(JSON.stringify(source.slice(0, 40)), () => {
      const once = docToMarkdown(docFrom(markdownToDoc(source)));
      const twice = docToMarkdown(docFrom(markdownToDoc(once)));
      expect(twice).toBe(once);
    });
  }
});

describe("markdown keeps the user's characters", () => {
  for (const source of MARKDOWN_CORPUS) {
    it(JSON.stringify(source.slice(0, 40)), () => {
      const normalized = docToMarkdown(docFrom(markdownToDoc(source)));
      // Strip syntax, keep prose. The checkbox goes first and whole: its state
      // is a marker, and `[X]` normalizing to `[x]` is not a lost character.
      const visible = (value: string) =>
        value.replace(/\[[ xX]\]/g, "").replace(/[\s\\`*~=[\]_>#|(){}.+-]/g, "");
      expect(visible(normalized)).toBe(visible(source));
    });
  }
});

/* ------------------------------------------------------------------ *
 * What markdown cannot hold
 * ------------------------------------------------------------------ */

/**
 * The four normalizations the module documents, reimplemented here from its
 * prose rather than shared with it.
 *
 * The point of writing them twice is that the property below then asserts
 * something real: that these rules are the *only* difference a round trip can
 * make. A helper exported from the module and reused here would agree with the
 * serializer by construction, including where both are wrong.
 */
/** ProseMirror JSON, loosely enough typed that the normalizer can take a
 * document apart and put it back together. */
type J = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: J[];
};

const TEXTBLOCK = new Set(["paragraph", "heading"]);
const LIST = new Set(["bulletList", "orderedList", "taskList"]);

function isBreak(node: J) {
  return node.type === "hardBreak";
}

/** Bare text is the only inline node whose rendering can end a line in a
 * space: every mark closes with a delimiter of its own. */
function endsRenderedLineInSpace(node: J | undefined) {
  return node?.type === "text" && !node.marks?.length && /\s$/.test(node.text ?? "");
}

/** Apply the four documented rules to one textblock. Returns null when nothing
 * is left of it. */
function normalizeTextblock(node: J): J | null {
  let kids = [...(node.content ?? [])];

  while (kids.length && isBreak(kids[kids.length - 1])) kids.pop();
  while (kids.length && isBreak(kids[0])) kids.shift();
  kids = kids.filter((kid, index) => !(isBreak(kid) && isBreak(kids[index - 1] ?? { type: "" })));

  if (node.type === "heading") {
    const flattened: J[] = [];
    for (const kid of kids) {
      if (!isBreak(kid)) {
        flattened.push(kid);
        continue;
      }
      if (!endsRenderedLineInSpace(flattened[flattened.length - 1])) {
        flattened.push({ type: "text", text: " " });
      }
    }
    kids = flattened;
  }

  kids = kids.map((kid, index) => {
    const atLineEnd = index === kids.length - 1 || isBreak(kids[index + 1]);
    if (!atLineEnd || kid.type !== "text" || kid.marks?.length) return kid;
    return { ...kid, text: (kid.text ?? "").replace(/[ \t]+$/, "") };
  });

  kids = kids.filter((kid) => kid.type !== "text" || (kid.text ?? "").length > 0);
  return kids.length ? { ...node, content: kids } : null;
}

/** Two lists of the same kind with nothing between them read back as one. */
function mergeAdjacentLists(blocks: J[]): J[] {
  const merged: J[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (previous && LIST.has(block.type) && previous.type === block.type) {
      merged[merged.length - 1] = {
        ...previous,
        content: [...(previous.content ?? []), ...(block.content ?? [])],
      };
      continue;
    }
    merged.push(block);
  }
  return merged;
}

function normalizeBlock(node: J): J | null {
  if (node.type === "codeBlock") return node;
  if (TEXTBLOCK.has(node.type)) return normalizeTextblock(node);
  if (!node.content) return node;
  const content = mergeAdjacentLists(
    node.content.map(normalizeBlock).filter((child): child is J => child !== null),
  );
  return content.length ? { ...node, content } : null;
}

function normalizeDoc(json: J): J {
  const content = mergeAdjacentLists(
    (json.content ?? []).map(normalizeBlock).filter((child): child is J => child !== null),
  );
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

describe("the states markdown cannot hold, one by one", () => {
  it("drops a hard break at the end of a block", () => {
    const { json } = roundTripJson(doc(paragraph(text("a"), { type: "hardBreak" })));
    expect(json).toEqual(doc(paragraph(text("a"))));
  });

  it("drops a hard break at the start of a block", () => {
    const { json } = roundTripJson(doc(paragraph({ type: "hardBreak" }, text("a"))));
    expect(json).toEqual(doc(paragraph(text("a"))));
  });

  it("collapses consecutive hard breaks, which would be a blank line", () => {
    const { json } = roundTripJson(
      doc(paragraph(text("a"), { type: "hardBreak" }, { type: "hardBreak" }, text("b"))),
    );
    expect(json).toEqual(doc(paragraph(text("a"), { type: "hardBreak" }, text("b"))));
  });

  it("turns a hard break in a heading into a space, outside the marks", () => {
    const { markdown, json } = roundTripJson(
      doc({
        type: "heading",
        attrs: { level: 2 },
        content: [text("one", "bold"), { type: "hardBreak" }, text("two")],
      }),
    );
    expect(markdown).toBe("## **one** two");
    expect(json).toEqual(
      doc({ type: "heading", attrs: { level: 2 }, content: [text("one", "bold"), text(" two")] }),
    );
  });

  it("does not double a space the heading already ends with", () => {
    const { markdown } = roundTripJson(
      doc({
        type: "heading",
        attrs: { level: 1 },
        content: [text("one "), { type: "hardBreak" }, text("two")],
      }),
    );
    expect(markdown).toBe("# one two");
  });

  it("trims trailing whitespace, but not inside a code block", () => {
    expect(roundTripJson(doc(paragraph(text("a   ")))).json).toEqual(doc(paragraph(text("a"))));
    const code = doc({
      type: "codeBlock",
      attrs: { language: null },
      content: [text("a   \n  b")],
    });
    expect(roundTripJson(code).json).toEqual(code);
  });

  it("keeps whitespace that a mark encloses", () => {
    const json = doc(paragraph(text("a   ", "bold")));
    expect(roundTripJson(json).json).toEqual(json);
  });

  it("drops a block left with nothing in it", () => {
    const { json } = roundTripJson(doc(paragraph(text("a")), paragraph(), paragraph(text("b"))));
    expect(json).toEqual(doc(paragraph(text("a")), paragraph(text("b"))));
  });

  it("does not escape a bracket that opens nothing", () => {
    const { markdown } = roundTripJson(doc(paragraph(text("see [t:12] and [1] and ~ here"))));
    expect(markdown).toBe("see [t:12] and [1] and ~ here");
  });

  it("escapes a bracket that would close a link, and a doubled tilde", () => {
    const literal = doc(paragraph(text("[a](b) and ~~x~~")));
    const { markdown, json } = roundTripJson(literal);
    expect(markdown).toBe("[a\\](b) and \\~~x\\~~");
    expect(json).toEqual(literal);
  });

  it("escapes a bracket inside a link's own text", () => {
    const json = doc(
      paragraph({
        type: "text",
        text: "a]b",
        marks: [{ type: "link", attrs: { href: "https://example.com/" } }],
      }),
    );
    expect(roundTripJson(json).json).toEqual(docFrom(json).toJSON());
  });

  it("reads two adjacent lists of the same kind back as one", () => {
    const { json } = roundTripJson(
      doc(
        { type: "bulletList", content: [item(paragraph(text("a")))] },
        { type: "bulletList", content: [item(paragraph(text("b")))] },
      ),
    );
    expect(json).toEqual(
      doc({
        type: "bulletList",
        content: [item(paragraph(text("a"))), item(paragraph(text("b")))],
      }),
    );
  });

  it("keeps two adjacent lists of different kinds apart", () => {
    const json = doc(
      { type: "bulletList", content: [item(paragraph(text("a")))] },
      { type: "orderedList", attrs: { start: 1 }, content: [item(paragraph(text("b")))] },
    );
    expect(roundTripJson(json).json).toEqual(docFrom(json).toJSON());
  });
});

/* ------------------------------------------------------------------ *
 * The markdown this app actually produces
 * ------------------------------------------------------------------ */

/**
 * A synthetic corpus proves the converter is self-consistent. These are the
 * three shapes that really reach a note: `note_generate.md` writes `#`
 * headings and bullets, a long-form summary writes `##` headings carrying a
 * `[t:N]` marker (ADR-0027), and the assistant writes whatever it likes
 * through `crate::agent_notes`.
 */
const REAL_WORLD = {
  "a generated meeting note": [
    "# Pricing decision",
    "",
    "- Agreed to hold the current tier until the Q4 review.",
    "- **Marie** owns the migration plan, due Friday.",
    "",
    "# Open questions",
    "",
    "- Whether the enterprise SLA covers the EU region.",
  ].join("\n"),

  "a long-form summary with chapter markers": [
    "The recording is a two-hour conversation about distributed systems.",
    "",
    "## [t:12] The pricing question",
    "",
    'She pushes back: "the number is not the point, the commitment is".',
    "",
    "## [t:87] What they decided",
    "",
    "1. Ship the smaller change first.",
    "2. Revisit in November.",
  ].join("\n"),

  "a note the assistant wrote": [
    "# Recipe",
    "",
    "> From the podcast, roughly transcribed.",
    "",
    "1. Warm the pan.",
    "   - Cast iron works best.",
    "2. Add `2 tbsp` of oil.",
    "",
    "See [the original](https://example.com/ep/12) for the timings.",
    "",
    "---",
    "",
    "```sh",
    "curl -s https://example.com | jq .",
    "```",
  ].join("\n"),

  "a meeting note with things to do": [
    "# Séance du 31 août",
    "",
    "- [x] Envoyer les PDF via wetransfert",
    "- [ ] Prévenir Sébastien de la date d'intervention",
    "  - [ ] confirmer avec son électricien",
    "- [ ] Refaire le FIA quand les plans sont envoyés",
    "",
    "Le point ==bloquant== reste la facture de l'électricien.",
  ].join("\n"),

  "a note with an unsupported table in it": [
    "# Numbers",
    "",
    "| region | growth |",
    "| ------ | ------ |",
    "| EU     | 12%    |",
    "",
    "Nothing here renders as a table, and every character is still here.",
  ].join("\n"),
};

describe("the markdown this app actually writes", () => {
  for (const [name, source] of Object.entries(REAL_WORLD)) {
    it(`${name} survives unchanged`, () => {
      expect(docToMarkdown(docFrom(markdownToDoc(source)))).toBe(source);
    });
  }
});

/* ------------------------------------------------------------------ *
 * P3 — generated documents, so the corpus cannot be the whole test
 * ------------------------------------------------------------------ */

/** A small deterministic PRNG: a seeded run reproduces exactly, so a failure
 * is a bug report and not a coin toss. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS = [
  "alpha",
  "beta",
  "- gamma",
  "delta*",
  "_epsilon",
  "zeta`",
  "#eta",
  "> theta",
  "1. iota",
  "kappa]",
  "[lambda",
  "mu~nu",
  "xi\\omicron",
  "pi",
  "snake_case_word",
  "rho ** sigma",
  "tau",
  "***upsilon",
  "phi | chi",
  "psi",
  "omega   ",
];
const MARK_NAMES = ["bold", "italic", "strike", "code", "highlight"] as const;

function randomInline(random: () => number, depth: number): unknown[] {
  const count = 1 + Math.floor(random() * 3);
  const nodes: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    if (random() < 0.15 && nodes.length) {
      nodes.push({ type: "hardBreak" });
      continue;
    }
    const value = WORDS[Math.floor(random() * WORDS.length)];
    const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
    if (random() < 0.4) {
      const name = MARK_NAMES[Math.floor(random() * MARK_NAMES.length)];
      marks.push({ type: name });
      // `code` is exclusive in practice: the serializer writes the span whole.
      if (name !== "code" && random() < 0.3) marks.push({ type: "bold" });
    } else if (random() < 0.15 && depth === 0) {
      marks.push({ type: "link", attrs: { href: "https://example.com/x" } });
    }
    const unique = marks.filter(
      (mark, position) => marks.findIndex((other) => other.type === mark.type) === position,
    );
    nodes.push(
      unique.length ? { type: "text", text: value, marks: unique } : { type: "text", text: value },
    );
  }
  return nodes;
}

function randomBlock(random: () => number, depth: number): unknown {
  const roll = random();
  if (depth < 2 && roll < 0.18) {
    const kind = random();
    const items = 1 + Math.floor(random() * 3);
    const content = Array.from({ length: items }, () => {
      const blocks: unknown[] = [{ type: "paragraph", content: randomInline(random, depth + 1) }];
      if (random() < 0.35) blocks.push(randomBlock(random, depth + 1));
      return blocks;
    });
    if (kind < 0.33) {
      return {
        type: "taskList",
        content: content.map((blocks) => ({
          type: "taskItem",
          attrs: { checked: random() < 0.5 },
          content: blocks,
        })),
      };
    }
    const listItems = content.map((blocks) => ({ type: "listItem", content: blocks }));
    return kind < 0.66
      ? { type: "orderedList", attrs: { start: 1 + Math.floor(random() * 3) }, content: listItems }
      : { type: "bulletList", content: listItems };
  }
  if (depth < 2 && roll < 0.26) {
    return {
      type: "blockquote",
      content: [{ type: "paragraph", content: randomInline(random, depth + 1) }],
    };
  }
  if (roll < 0.32) return { type: "horizontalRule" };
  if (roll < 0.4) {
    return {
      type: "codeBlock",
      attrs: { language: random() < 0.5 ? "ts" : null },
      content: [{ type: "text", text: "a\n  b\n```\nc" }],
    };
  }
  if (roll < 0.55) {
    return {
      type: "heading",
      attrs: { level: 1 + Math.floor(random() * 3) },
      content: randomInline(random, depth + 1),
    };
  }
  return { type: "paragraph", content: randomInline(random, depth + 1) };
}

describe("generated documents survive being written and read back", () => {
  for (let seed = 1; seed <= 1000; seed += 1) {
    it(`seed ${seed}`, () => {
      const random = makeRandom(seed * 2654435761);
      const blocks = 1 + Math.floor(random() * 4);
      const json = {
        type: "doc",
        content: Array.from({ length: blocks }, () => randomBlock(random, 0)),
      };
      const original = docFrom(json);
      const markdown = docToMarkdown(original);
      const expected = docFrom(normalizeDoc(original.toJSON())).toJSON();
      expect(docFrom(markdownToDoc(markdown)).toJSON()).toEqual(expected);
    });
  }
});
