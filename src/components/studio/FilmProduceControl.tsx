// The production cost handshake, as one control (ADR-0010): the first click
// asks the studio for a quote, the second confirms the exact figure it
// answered. Shared by the run banner (an autonomous run that stopped on the
// cost) and the director panel, so both spend money the same way: a quote the
// user reads, then an echo of that quote.

import { useCallback, useState } from "react";
import { parseProduceOutcome } from "../../lib/films";
import { videomakerProduce } from "../../lib/tauri";

type ErrorLike = { message?: string };

function errorMessage(error: unknown): string {
  const message = (error as ErrorLike)?.message;
  return typeof message === "string" && message ? message : "Something went wrong.";
}

export function FilmProduceControl({
  slug,
  onStarted,
  onError,
  idleLabel = "Get a production quote",
}: {
  slug: string;
  /** Production actually started (the studio spawned the render daemon). */
  onStarted?: () => void;
  onError?: (message: string) => void;
  idleLabel?: string;
}) {
  const [quoteDiem, setQuoteDiem] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const produce = useCallback(async () => {
    setBusy(true);
    try {
      const outcome = parseProduceOutcome(await videomakerProduce(slug, quoteDiem ?? undefined));
      if (outcome.needsConfirmation) {
        // A quote (first call) or a re-quote (the queue grew since): show the
        // new figure and wait for a fresh, explicit confirmation.
        setQuoteDiem(outcome.projectedCostDiem ?? null);
      } else {
        setQuoteDiem(null);
        onStarted?.();
      }
    } catch (cause) {
      onError?.(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [slug, quoteDiem, onStarted, onError]);

  return (
    <>
      {quoteDiem !== null ? (
        <p className="studio-quote">
          Projected production cost: {quoteDiem.toLocaleString()} DIEM.
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy}
        onClick={() => void produce()}
      >
        {busy
          ? "Working..."
          : quoteDiem !== null
            ? `Confirm and produce (${quoteDiem.toLocaleString()} DIEM)`
            : idleLabel}
      </button>
    </>
  );
}
