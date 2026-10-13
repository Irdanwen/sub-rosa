// What the Studio header says about money and time: how many renders are in
// flight, and the balance with today's rate. The same two facts the phone
// shows in its Studio header, so a person never has to leave the work to
// know either.

import { useRef, useState } from "react";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { requestAddCredits } from "../../../lib/credits-events";
import { usePayPolicy } from "../../../lib/credits-purchase";
import { t } from "../../../lib/i18n";
import { formatCredits } from "../../../lib/studio/catalog";
import { isStudioOwned, useRunningMediaJobs } from "../../../lib/studio/media-jobs-live";
import { rateBadge, rateSentence } from "../../../lib/studio/rate";
import { Popover } from "../../ui/Popover";

/** Renders the Studio queued by hand that are still running, plus the
 * synchronous ones a desk reports itself (they write no job row). */
export function useStudioRunningCount(localWorking: number): number {
  const running = useRunningMediaJobs();
  return running.filter(isStudioOwned).length + localWorking;
}

export function StudioStatus({ running }: { running: number }) {
  const reported = useCarpeDiemCredits();
  // An answer without a balance (an older sidecar, a test double) shows no pill.
  const credits = typeof reported?.availableCredits === "number" ? reported : null;
  const payLinkAllowed = usePayPolicy()?.linkAllowed === true;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const badge = credits ? rateBadge(credits.priceMultiplier) : undefined;
  return (
    <div className="studio-header-status">
      {running > 0 ? (
        <span className="studio-running" role="status">
          <span className="studio-running-dot" aria-hidden />
          {running === 1
            ? t("1 render in progress")
            : t("{count} renders in progress", { count: running })}
        </span>
      ) : null}
      {credits ? (
        <>
          <button
            ref={anchor}
            type="button"
            className="studio-credits-pill"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={t("Available credits: {credits}", {
              credits: formatCredits(credits.availableCredits),
            })}
            onClick={() => setOpen((current) => !current)}
          >
            {formatCredits(credits.availableCredits)}
            {badge ? <span className="studio-credits-rate">{badge}</span> : null}
          </button>
          <Popover
            anchorRef={anchor}
            open={open}
            onClose={() => setOpen(false)}
            label={t("Credits")}
            width={300}
          >
            <div className="studio-credits-card">
              <strong>{formatCredits(credits.availableCredits)}</strong>
              <p>{rateSentence(credits.priceMultiplier)}</p>
              {payLinkAllowed ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setOpen(false);
                    requestAddCredits();
                  }}
                >
                  {t("Top up")}
                </button>
              ) : null}
            </div>
          </Popover>
        </>
      ) : null}
    </div>
  );
}
