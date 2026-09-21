import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { t, intlLocale } from "../../lib/i18n";
import { messageFromError } from "../../lib/errors";
import { listArtifacts, readArtifactBase64 } from "../../lib/studio/artifacts";
import "../../styles/assistant-media.css";

export type AssistantMediaProposal = {
  id: string;
  task_id: string;
  kind: "image" | "edit" | "upscale" | "video" | "music" | "speech";
  model: string;
  prompt: string;
  parameters: Record<string, unknown>;
  cost_credits: number | null;
  status: "proposed" | "submitting" | "queued" | "completed" | "failed" | "uncertain";
  artifact_file_name: string | null;
  error: string | null;
};

function statusLabel(status: AssistantMediaProposal["status"]) {
  switch (status) {
    case "proposed":
      return t("Ready to generate");
    case "submitting":
      return t("Starting generation");
    case "queued":
      return t("Generating");
    case "completed":
      return t("Ready");
    case "failed":
      return t("Generation failed");
    case "uncertain":
      return t("Submission uncertain");
  }
}

function settingLabel(key: string) {
  const labels: Record<string, string> = {
    width: t("Width"),
    height: t("Height"),
    seed: t("Seed"),
    aspect_ratio: t("Aspect ratio"),
    duration: t("Duration"),
    duration_seconds: t("Duration in seconds"),
    resolution: t("Resolution"),
    voice: t("Voice"),
    speed: t("Speed"),
    scale: t("Scale"),
    reference_id: t("Image reference"),
    lyrics_prompt: t("Lyrics"),
    force_instrumental: t("Instrumental"),
  };
  return labels[key] ?? key;
}

function useMediaUpdates(refresh: () => void) {
  useEffect(() => {
    let disposed = false;
    const subscriptions = ["subrosa://assistant-media", "june://media-job"].map((event) =>
      listen(event, refresh)
        .then((stop) => {
          if (disposed) stop();
          return stop;
        })
        .catch(() => () => {}),
    );
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      for (const pending of subscriptions) void pending.then((stop) => stop());
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
}

/** Queries durable native proposals so even an omitted model fence cannot hide a job. */
export function AssistantMediaList({
  taskId,
  excludeIds = [],
}: {
  taskId: string;
  excludeIds?: string[];
}) {
  return <MediaList key={taskId} taskId={taskId} excludeIds={excludeIds} />;
}

function MediaList({ taskId, excludeIds }: { taskId: string; excludeIds: string[] }) {
  const [proposals, setProposals] = useState<AssistantMediaProposal[]>([]);
  const [error, setError] = useState<string>();
  const version = useRef(0);
  const refresh = useCallback(() => {
    const request = ++version.current;
    void invoke<AssistantMediaProposal[]>("assistant_media_list", { taskId })
      .then((value) => {
        if (request !== version.current) return;
        setProposals(value.filter((proposal) => proposal.task_id === taskId));
        setError(undefined);
      })
      .catch((reason) => {
        if (request === version.current) setError(messageFromError(reason));
      });
  }, [taskId]);
  useEffect(() => {
    refresh();
    return () => {
      version.current++;
    };
  }, [refresh]);
  useMediaUpdates(refresh);
  if (error) return <p role="status">{error}</p>;
  if (!proposals.length) return null;
  return (
    <section aria-label={t("Generations")} className="assistant-media-list">
      {proposals
        .filter((proposal) => !excludeIds.includes(proposal.id))
        .map((proposal) => (
          <AssistantMediaCard key={proposal.id} id={proposal.id} initial={proposal} />
        ))}
    </section>
  );
}

export function AssistantMediaCard({
  id,
  initial,
}: {
  id: string;
  initial?: AssistantMediaProposal;
}) {
  return <MediaCard key={id} id={id} initial={initial?.id === id ? initial : undefined} />;
}

function MediaCard({ id, initial }: { id: string; initial?: AssistantMediaProposal }) {
  const [proposal, setProposal] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [src, setSrc] = useState<string>();
  const version = useRef(0);
  const executing = useRef(false);
  const refresh = useCallback(() => {
    const request = ++version.current;
    void invoke<AssistantMediaProposal>("assistant_media_get", { id })
      .then((value) => {
        if (request !== version.current || value.id !== id) return;
        setProposal(value);
        setError(undefined);
      })
      .catch((reason) => {
        if (request === version.current) setError(messageFromError(reason));
      });
  }, [id]);
  useEffect(() => {
    refresh();
    return () => {
      version.current++;
    };
  }, [refresh]);
  useMediaUpdates(refresh);
  useEffect(() => {
    let disposed = false;
    setSrc(undefined);
    if (proposal?.artifact_file_name) {
      const filename = proposal.artifact_file_name;
      void listArtifacts()
        .then(async (artifacts) => {
          const artifact = artifacts.find((item) => item.id === filename);
          if (!artifact) return;
          // Large results stay in the gallery rather than allocating a second
          // enormous base64 copy in a chat webview on a phone.
          if (artifact.bytes > 32 * 1024 * 1024) return;
          const base64 = await readArtifactBase64(artifact);
          const ext = filename.split(".").at(-1);
          const mime =
            ext === "mp4"
              ? "video/mp4"
              : ext === "mp3"
                ? "audio/mpeg"
                : ext === "wav"
                  ? "audio/wav"
                  : ext === "webp"
                    ? "image/webp"
                    : ext === "jpg" || ext === "jpeg"
                      ? "image/jpeg"
                      : "image/png";
          if (!disposed) setSrc(`data:${mime};base64,${base64}`);
        })
        .catch((reason) => {
          if (!disposed) setError(messageFromError(reason));
        });
    }
    return () => {
      disposed = true;
    };
  }, [proposal?.artifact_file_name]);
  const execute = async () => {
    if (executing.current || proposal?.id !== id || proposal.status !== "proposed") return;
    executing.current = true;
    const request = ++version.current;
    setBusy(true);
    setError(undefined);
    try {
      const value = await invoke<AssistantMediaProposal>("assistant_media_execute", {
        id: proposal.id,
      });
      if (request === version.current && value.id === id) setProposal(value);
    } catch (reason) {
      if (request === version.current) setError(messageFromError(reason));
    } finally {
      executing.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="chat-block assistant-media-card" aria-label={t("Generation")}>
      {proposal ? (
        <>
          <div className="assistant-media-heading">
            <strong>{proposal.model}</strong>
            <span role="status">{statusLabel(proposal.status)}</span>
          </div>
          <p>{proposal.prompt}</p>
          {Object.keys(proposal.parameters).length > 0 ? (
            <details>
              <summary>{t("Generation settings")}</summary>
              <dl className="assistant-media-settings">
                {Object.entries(proposal.parameters).map(([key, value]) => (
                  <div key={key}>
                    <dt>{settingLabel(key)}</dt>
                    <dd>
                      {key === "reference_id"
                        ? t("Selected image")
                        : typeof value === "boolean"
                          ? value
                            ? t("Yes")
                            : t("No")
                          : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
          {proposal.status === "proposed" ? (
            <div className="assistant-media-confirm">
              <span>
                {proposal.cost_credits === null
                  ? t("Price unavailable. This generation uses your credits.")
                  : t("Estimated price: {credits} credits", {
                      credits: new Intl.NumberFormat(intlLocale(), {
                        maximumFractionDigits: 2,
                      }).format(proposal.cost_credits),
                    })}
              </span>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => void execute()}
              >
                {busy ? t("Starting generation") : t("Generate")}
              </button>
            </div>
          ) : null}
          {proposal.status === "uncertain" ? (
            <p>
              {t(
                "The submission was interrupted. Check your usage before starting another generation.",
              )}
            </p>
          ) : null}
          {proposal.error ? <p role="status">{t(proposal.error)}</p> : null}
          {src ? (
            proposal.kind === "video" ? (
              <video src={src} controls playsInline aria-label={t("Generated video")}>
                <track kind="captions" />
              </video>
            ) : proposal.kind === "music" || proposal.kind === "speech" ? (
              <audio src={src} controls aria-label={t("Generated audio")}>
                <track kind="captions" />
              </audio>
            ) : (
              <img src={src} alt={proposal.prompt} />
            )
          ) : null}
          {proposal.status === "completed" ? <p>{t("Saved in your Studio gallery.")}</p> : null}
        </>
      ) : (
        <p>{error || t("Loading generation")}</p>
      )}
      {proposal && error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
