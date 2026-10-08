import { type ReactNode, useEffect, useState } from "react";
import {
  codeLanguage,
  codeLanguagesLoaded,
  highlightCode,
  loadCodeLanguages,
  onCodeLanguagesLoaded,
} from "../../lib/code-highlight";
import "../../styles/code-highlight.css";

/**
 * The text of a chat code block, coloured by its language (`code-highlight`).
 * `fallback` is what shows while the grammars load or when the language is
 * one they do not know: the plain text, or a surface's own lighter colouring.
 */
export function HighlightedCode({
  code,
  language,
  fallback,
}: {
  code: string;
  language?: string | null;
  fallback?: ReactNode;
}) {
  const name = codeLanguage(language);
  const [, setLoaded] = useState(codeLanguagesLoaded);
  useEffect(() => {
    if (!name || codeLanguagesLoaded()) return;
    const stop = onCodeLanguagesLoaded(() => setLoaded(true));
    void loadCodeLanguages().catch(() => undefined);
    return stop;
  }, [name]);

  const spans = highlightCode(code, name);
  if (!spans) return <>{fallback ?? code}</>;
  return (
    <span className="code-hl">
      {spans.map((span, index) =>
        span.className ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
          <span key={index} className={span.className}>
            {span.text}
          </span>
        ) : (
          span.text
        ),
      )}
    </span>
  );
}
