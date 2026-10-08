import { createLowlight } from "lowlight";

/**
 * Syntax colour for fenced code: the note editor's code blocks (a code
 * canvas is one of them) and the code blocks of a chat reply, on both shells.
 *
 * One highlighter for all of them, and its grammars are a separate chunk
 * loaded the first time a code block names a language: most notes and most
 * replies hold no code, and they should not pay for twenty grammars. Until
 * the chunk lands, code shows plain, and every surface repaints once it has.
 *
 * Only a block that names a language is coloured. Guessing the language of a
 * bare block colours a meeting note's pasted log as if it were Perl, which is
 * worse than no colour at all.
 *
 * Colours come from the `--code-*` tokens (code-highlight.css), so both
 * themes and the contrast gate cover them.
 */

export const lowlight = createLowlight();

let loading: Promise<void> | null = null;
let loaded = false;
const listeners = new Set<() => void>();

export function codeLanguagesLoaded(): boolean {
  return loaded;
}

/** Loads the grammars once; concurrent callers share the load. */
export function loadCodeLanguages(): Promise<void> {
  if (!loading) {
    loading = import("./code-languages")
      .then(({ registerCodeLanguages }) => {
        registerCodeLanguages(lowlight);
        loaded = true;
        for (const listener of listeners) listener();
      })
      .catch((cause) => {
        loading = null;
        throw cause;
      });
  }
  return loading;
}

/** Called once the grammars are in. Returns the unsubscribe. */
export function onCodeLanguagesLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The language a fence or a code block names, as the highlighter knows it. */
export function codeLanguage(language: unknown): string | null {
  if (typeof language !== "string") return null;
  const name = language.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return name ? name : null;
}

/** A run of code text and the classes that colour it. */
export type CodeSpan = { text: string; className: string };

type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  properties?: { className?: unknown };
  children: HastNode[];
};
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

function flatten(nodes: HastNode[], classes: string[], spans: CodeSpan[]) {
  for (const node of nodes) {
    if (node.type === "text") {
      spans.push({ text: (node as HastText).value, className: classes.join(" ") });
      continue;
    }
    const element = node as HastElement;
    const own = element.properties?.className;
    const next = Array.isArray(own) ? [...classes, ...own.map(String)] : classes;
    flatten(element.children ?? [], next, spans);
  }
}

/**
 * `code` cut into coloured runs, or `null` when it should show plain: no
 * language, one the highlighter does not know, or grammars not loaded yet.
 * The runs always add up to `code`, character for character.
 */
export function highlightCode(code: string, language: unknown): CodeSpan[] | null {
  const name = codeLanguage(language);
  if (!name || !loaded || !lowlight.registered(name)) return null;
  try {
    const tree = lowlight.highlight(name, code);
    const spans: CodeSpan[] = [];
    flatten(tree.children as HastNode[], [], spans);
    return spans;
  } catch {
    return null;
  }
}
