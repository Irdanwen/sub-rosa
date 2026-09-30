import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorCode, friendlyErrorMessage } from "../errors";
import { t } from "../i18n";
import { isSeedanceModel } from "./catalog";
import { referenceMention } from "./seedance";
import { SEEDANCE_WORD_LIMIT } from "./bible/prompt";
import type { MediaModel } from "./types";

/**
 * Studio's "improve with AI", from the click to the proposal.
 *
 * The command is `studio_ai` in Rust, which shares its stream with the note
 * editor's rewrites and follows the same rule (ADR-0038): nothing here writes
 * to the project. The hook produces a proposal, the field shows it, and only
 * the person's Accept puts it in the document, where the project saves it
 * like any other edit.
 */

export const STUDIO_REWRITE_EVENT = "june://studio-rewrite";

/** Mirrors `studio_ai::MAX_MATERIAL_CHARS`, so an oversize scenario is refused
 * before it costs a round trip. */
export const MAX_STUDIO_REWRITE_CHARS = 24_000;

export type StudioRewriteKind =
  | "scenario"
  | "shotPrompt"
  | "imagePrompt"
  | "composition"
  | "musicPrompt";
export type ScenarioIntent = "filmable" | "develop" | "tighten" | "custom";

export interface RewriteTargetModel {
  id: string;
  name?: string;
  charLimit?: number;
  wordLimit?: number;
  /** How the family reads the n-th reference, `{n}` for the number. */
  referenceMention?: string;
}

export interface RewriteContextEntry {
  name: string;
  kind: string;
  traits?: string;
}

export interface CompositionSlot {
  label: string;
  kind: string;
  role?: string;
}

export interface StudioRewriteContext {
  targetModel?: RewriteTargetModel;
  mode?: string;
  title?: string;
  action?: string;
  camera?: string;
  speaker?: string;
  dialogue?: string;
  duration?: string;
  aspectRatio?: string;
  entries?: RewriteContextEntry[];
  entry?: RewriteContextEntry;
  role?: string;
  slots?: CompositionSlot[];
  /** A score's shared identity, for a cue's prompt. */
  identity?: string;
  mood?: string;
  intensity?: string;
  /** What is on screen under a cue, shot by shot. */
  scenes?: string[];
}

export interface StudioRewriteInput {
  kind: StudioRewriteKind;
  text: string;
  intent?: ScenarioIntent;
  instruction?: string;
  context?: StudioRewriteContext;
  modelId?: string;
}

interface StudioRewriteEvent {
  requestId: string;
  phase: "started" | "delta" | "done" | "failed";
  text: string | null;
}

export function studioRewrite(request: StudioRewriteInput & { requestId: string }) {
  return invoke<{ requestId: string; text: string; promptVersion: string }>("studio_rewrite", {
    request: { ...request, context: request.context ?? {} },
  });
}

export function cancelStudioRewrite(requestId: string) {
  return invoke<void>("cancel_studio_rewrite", { requestId });
}

/**
 * What a rewrite needs to know about the model a prompt is for: its hard
 * length limits and how it reads references. The limits come from the
 * operator's catalog where it publishes them; the sixty words are the
 * Seedance families' own, already enforced by `shotPrompt`.
 */
export function rewriteTargetModel(model: MediaModel | undefined): RewriteTargetModel | undefined {
  if (!model) return undefined;
  return {
    id: model.id,
    name: model.name,
    charLimit: model.constraints?.promptCharacterLimit,
    wordLimit: isSeedanceModel(model.id) ? SEEDANCE_WORD_LIMIT : undefined,
    referenceMention: referenceMention(model, "image", 1).replace("1", "{n}"),
  };
}

export interface StudioRewriteRun {
  requestId: string;
  input: StudioRewriteInput;
  status: "running" | "ready" | "failed" | "cancelled";
  /** Streamed so far while running, the final text once ready. */
  text: string;
  error?: string;
}

let requestCounter = 0;

function nextRequestId() {
  requestCounter += 1;
  return `studio-rewrite-${Date.now()}-${requestCounter}`;
}

export function useStudioRewrite() {
  const [run, setRun] = useState<StudioRewriteRun | null>(null);
  // A late delta from a run the person already discarded must not paint into
  // the next one.
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    // The deltas are a preview, so their channel is optional: with no Tauri
    // bridge the field shows nothing until the command resolves.
    try {
      void listen<StudioRewriteEvent>(STUDIO_REWRITE_EVENT, (event) => {
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
      // Leaving the screen stops paying for a proposal nobody will read.
      if (activeId.current)
        void Promise.resolve(cancelStudioRewrite(activeId.current)).catch(() => undefined);
    },
    [],
  );

  const start = useCallback((input: StudioRewriteInput) => {
    if (input.text.length > MAX_STUDIO_REWRITE_CHARS) {
      setRun({
        requestId: "",
        input,
        status: "failed",
        text: "",
        error: t("That text is too long to rewrite in one go. Keep it under {count} characters.", {
          count: MAX_STUDIO_REWRITE_CHARS,
        }),
      });
      return;
    }
    const requestId = nextRequestId();
    activeId.current = requestId;
    setRun({ requestId, input, status: "running", text: "" });
    void Promise.resolve(studioRewrite({ requestId, ...input }))
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
        const message = friendlyErrorMessage(error, t("That rewrite did not go through."));
        setRun((current) =>
          current && current.requestId === requestId
            ? {
                ...current,
                // The code, not the sentence: the sentence is translated.
                status: errorCode(error) === "studio_rewrite_cancelled" ? "cancelled" : "failed",
                error: message,
              }
            : current,
        );
      });
  }, []);

  const stop = useCallback(() => {
    if (activeId.current)
      void Promise.resolve(cancelStudioRewrite(activeId.current)).catch(() => undefined);
  }, []);

  const dismiss = useCallback(() => {
    if (activeId.current && run?.status === "running")
      void Promise.resolve(cancelStudioRewrite(activeId.current)).catch(() => undefined);
    activeId.current = null;
    setRun(null);
  }, [run?.status]);

  return { run, start, stop, dismiss };
}
