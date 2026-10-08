import { useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  MAX_REFINE_PASSES,
  type RefineEstimate,
  type RefinePassOutcome,
  estimateRefine,
  refinedVersions,
  runRefine,
} from "../../lib/image-refine";
import { listArtifacts, readArtifactBase64 } from "../../lib/studio/artifacts";
import { formatCredits } from "../../lib/studio/catalog";
import type { StudioArtifact } from "../../lib/studio/types";

type Phase =
  | { kind: "idle" }
  | { kind: "pricing" }
  | { kind: "confirm"; estimate: RefineEstimate }
  | { kind: "running"; status: string }
  | { kind: "done"; message: string };

function priceSentence(estimate: RefineEstimate): string {
  const passes = estimate.passes;
  if (estimate.totalCredits === undefined)
    return t(
      "Sub Rosa checks the picture against your prompt and fixes what is wrong, with up to {passes} edits. The price of an edit is not published.",
      { passes },
    );
  return t(
    "Sub Rosa checks the picture against your prompt and fixes what is wrong, with up to {passes} edits. At most {credits}, nothing for a check that finds nothing to fix.",
    { passes, credits: formatCredits(estimate.totalCredits) },
  );
}

/**
 * "Refine" on a finished chat picture: the price first, then up to two
 * critique and edit passes. The versions are read back from the gallery, so a
 * refine interrupted by a locked phone still shows what it made.
 */
export function RefinePanel({
  fileName,
  prompt,
  taskId,
}: {
  fileName: string;
  prompt: string;
  taskId?: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [versions, setVersions] = useState<StudioArtifact[]>([]);
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadVersions = useCallback(async () => {
    try {
      const found = refinedVersions(await listArtifacts("image"), fileName);
      if (!mounted.current) return;
      setVersions(found);
      const latest = found.at(-1);
      if (!latest) return;
      const base64 = await readArtifactBase64(latest);
      const mime = latest.fileName.endsWith(".jpg") ? "image/jpeg" : "image/png";
      if (mounted.current) setPreview(`data:${mime};base64,${base64}`);
    } catch {
      // The gallery is the record; a card that cannot read it shows nothing.
    }
  }, [fileName]);
  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  const askPrice = async () => {
    setError(undefined);
    setPhase({ kind: "pricing" });
    try {
      const estimate = await estimateRefine(MAX_REFINE_PASSES);
      if (mounted.current) setPhase({ kind: "confirm", estimate });
    } catch (reason) {
      if (!mounted.current) return;
      setError(messageFromError(reason));
      setPhase({ kind: "idle" });
    }
  };

  const refine = async (estimate: RefineEstimate) => {
    setError(undefined);
    setPhase({ kind: "running", status: t("Checking the picture against your prompt") });
    const onPass = (outcome: RefinePassOutcome) => {
      if (!mounted.current) return;
      if (outcome.fileName) void loadVersions();
      if (!outcome.critique.satisfied && outcome.n < estimate.passes && outcome.fileName)
        setPhase({ kind: "running", status: t("Checking the new version") });
    };
    try {
      const outcomes = await runRefine(
        { fileName, prompt, taskId, model: estimate.model, passes: estimate.passes },
        onPass,
      );
      if (!mounted.current) return;
      const made = outcomes.filter((outcome) => outcome.fileName).length;
      const pending = outcomes.some((outcome) => outcome.pending);
      setPhase({
        kind: "done",
        message: pending
          ? t("The edit is still rendering. It will appear in your Studio gallery.")
          : made === 0
            ? t("Nothing to fix: the picture already matches your prompt.")
            : t("Refined. Every version is kept in your Studio gallery."),
      });
      await loadVersions();
    } catch (reason) {
      if (!mounted.current) return;
      setError(messageFromError(reason));
      setPhase({ kind: "idle" });
      void loadVersions();
    }
  };

  const latest = versions.at(-1);
  return (
    <div className="assistant-media-refine">
      {preview && latest ? (
        <figure>
          <img src={preview} alt={t("Refined version of {prompt}", { prompt })} />
          <figcaption>
            {t("Refinement {n}", { n: latest.edit?.n ?? versions.length })}
            {latest.prompt ? ` · ${latest.prompt}` : ""}
          </figcaption>
        </figure>
      ) : null}
      {phase.kind === "idle" ? (
        <button type="button" className="assistant-media-secondary" onClick={() => void askPrice()}>
          {t("Refine")}
        </button>
      ) : phase.kind === "pricing" ? (
        <p role="status">{t("Getting the price")}</p>
      ) : phase.kind === "confirm" ? (
        <div className="assistant-media-confirm">
          <span>{priceSentence(phase.estimate)}</span>
          <span className="assistant-media-actions">
            <button
              type="button"
              className="assistant-media-secondary"
              onClick={() => setPhase({ kind: "idle" })}
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="assistant-media-generate"
              onClick={() => void refine(phase.estimate)}
            >
              {t("Refine")}
            </button>
          </span>
        </div>
      ) : phase.kind === "running" ? (
        <p role="status">{phase.status}</p>
      ) : (
        <p role="status">{phase.message}</p>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
