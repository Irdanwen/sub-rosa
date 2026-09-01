import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyErrorMessage } from "./errors";
import {
  cancelNoteRewrite,
  MAX_REWRITE_CHARS,
  noteRewrite,
  NOTE_REWRITE_EVENT,
  type NoteRewriteEvent,
  type RewriteKind,
} from "./tauri";

/**
 * Driving one rewrite, from the click to the text that comes back.
 *
 * Nothing here writes to the note. The hook produces a **revision** — text the
 * user has not accepted yet — and hands it to whoever asked. That separation
 * is the whole point of ADR-0038: a rewrite replaces something the person
 * wrote, so it is proposed and never applied.
 *
 * The deltas are a preview. `text` at the end comes from the command's return
 * value, not from the accumulated stream: a dropped frame would leave a hole
 * in the middle of the accumulator, and a hole in the middle of a paragraph is
 * the kind of corruption nobody notices until much later.
 */

export type RewriteRun = {
  requestId: string;
  kind: RewriteKind;
  /** What it is rewriting, kept so the panel can show before and after. */
  original: string;
  status: "running" | "ready" | "failed" | "cancelled";
  /** Streamed so far while running, the final text once ready. */
  text: string;
  error?: string;
};

export type StartRewrite = (input: {
  kind: RewriteKind;
  text: string;
  targetLanguage?: string;
  instruction?: string;
}) => void;

let requestCounter = 0;

function nextRequestId() {
  requestCounter += 1;
  return `note-rewrite-${Date.now()}-${requestCounter}`;
}

export function useNoteRewrite() {
  const [run, setRun] = useState<RewriteRun | null>(null);
  // The run the events belong to. A late delta from a run the user already
  // discarded must not paint into the next one.
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    // The deltas are a preview, so their channel is optional by design: with no
    // Tauri bridge — a test, or the standalone editor harness — the panel shows
    // nothing until the command resolves, instead of the editor failing to
    // mount at all.
    try {
      void listen<NoteRewriteEvent>(NOTE_REWRITE_EVENT, (event) => {
        const payload = event.payload;
        if (payload.requestId !== activeId.current) return;
        if (payload.phase !== "delta" || !payload.text) return;
        setRun((current) =>
          current && current.requestId === payload.requestId && current.status === "running"
            ? { ...current, text: current.text + payload.text }
            : current,
        );
      })
        .then((unlisten) => {
          if (gone) unlisten();
          else off = unlisten;
        })
        .catch(() => undefined);
    } catch {
      // Same case, thrown synchronously.
    }
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  useEffect(
    () => () => {
      // Leaving the note stops paying for a rewrite nobody will read.
      if (activeId.current) {
        void Promise.resolve(cancelNoteRewrite(activeId.current)).catch(() => undefined);
      }
    },
    [],
  );

  const start = useCallback<StartRewrite>((input) => {
    const text = input.text;
    if (!text.trim()) return;
    if (text.length > MAX_REWRITE_CHARS) {
      setRun({
        requestId: "",
        kind: input.kind,
        original: text,
        status: "failed",
        text: "",
        error: `That selection is too long to rewrite in one go. Select at most ${MAX_REWRITE_CHARS.toLocaleString()} characters.`,
      });
      return;
    }

    const requestId = nextRequestId();
    activeId.current = requestId;
    setRun({ requestId, kind: input.kind, original: text, status: "running", text: "" });

    void Promise.resolve(noteRewrite({ requestId, ...input }))
      .then((result) => {
        if (activeId.current !== requestId) return;
        setRun((current) =>
          current && current.requestId === requestId
            ? { ...current, status: "ready", text: result.text }
            : current,
        );
      })
      .catch((error) => {
        if (activeId.current !== requestId) return;
        const message = friendlyErrorMessage(error, "That rewrite did not go through.");
        setRun((current) =>
          current && current.requestId === requestId
            ? {
                ...current,
                status: /stopped/i.test(message) ? "cancelled" : "failed",
                error: message,
              }
            : current,
        );
      });
  }, []);

  const stop = useCallback(() => {
    const requestId = activeId.current;
    if (!requestId) return;
    void Promise.resolve(cancelNoteRewrite(requestId)).catch(() => undefined);
  }, []);

  const dismiss = useCallback(() => {
    const requestId = activeId.current;
    activeId.current = null;
    setRun(null);
    if (requestId) void Promise.resolve(cancelNoteRewrite(requestId)).catch(() => undefined);
  }, []);

  return { run, start, stop, dismiss };
}
