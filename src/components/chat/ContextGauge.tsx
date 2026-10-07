// A small ring that fills as the conversation grows toward the model's
// context window. Tap it (or rest the pointer on it) for the figure; past
// four fifths it turns to the warning tone and suggests a fresh chat, because
// a model that runs out of window forgets the start of the chat or refuses it.
// Shared by the phone chat and the desktop agent, so it carries no shell's
// classes.

import "../../styles/context-gauge.css";
import { useEffect, useId, useRef, useState } from "react";
import { type ContextGaugeReading, formatTokenCount } from "../../lib/context-gauge";
import { t } from "../../lib/i18n";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextGauge({
  reading,
  onNewChat,
}: {
  reading: ContextGaugeReading | null;
  /** Offered beside the warning when the chat is nearly full. */
  onNewChat?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Opened by a mouse resting on it. A click then keeps it open rather than
  // toggling it shut under the pointer; a tap toggles.
  const hoveredRef = useRef(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const detailId = useId();

  // A tap anywhere else closes the figure, as a popover does.
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  if (!reading) return null;
  const summary = t("About {used} of {total} tokens used", {
    used: formatTokenCount(reading.used),
    total: formatTokenCount(reading.total),
  });
  const warning = reading.tone === "warning";

  return (
    <span
      className="context-gauge"
      ref={rootRef}
      data-tone={reading.tone}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        hoveredRef.current = true;
        setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        hoveredRef.current = false;
        setOpen(false);
      }}
    >
      <button
        type="button"
        className="context-gauge-ring"
        aria-label={summary}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={() => setOpen((current) => hoveredRef.current || !current)}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle className="context-gauge-track" cx="9" cy="9" r={RADIUS} />
          <circle
            className="context-gauge-fill"
            cx="9"
            cy="9"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - reading.ratio)}
          />
        </svg>
      </button>
      {open ? (
        <span className="context-gauge-detail" id={detailId} role="status">
          <span>{summary}</span>
          {warning ? (
            <span className="context-gauge-warning">
              {t("This chat is getting long. A new chat keeps answers sharp.")}
            </span>
          ) : null}
          {warning && onNewChat ? (
            <button
              type="button"
              className="context-gauge-action"
              onClick={() => {
                setOpen(false);
                onNewChat();
              }}
            >
              {t("New chat")}
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
