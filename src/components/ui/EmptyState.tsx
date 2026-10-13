import type { ReactNode } from "react";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { t } from "../../lib/i18n";

/**
 * Shared empty-state surface: a quiet contained panel with a muted glyph, serif
 * title, supporting copy, and an optional action button under the copy. Used
 * anywhere a view has nothing to show yet, so Dictation, Routines, Agents,
 * etc. stay visually consistent.
 *
 * `action` and `footer` are different slots on purpose: calls to action live
 * in the content column, while the full-width inset footer is reserved for
 * supplementary reference material (the dictation shortcut hints) — a button
 * down there reads as a second surface rather than the next step.
 *
 * `size="compact"` is the same state inside something that already has a
 * frame (a settings card, a picker, a dialog list): no panel, a sans title,
 * less air. `tone="error"` is a list that could not load; it announces
 * itself (role="alert") instead of waiting to be found.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  footer,
  label,
  size = "panel",
  tone = "neutral",
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Call to action rendered in the content column, under the copy. */
  action?: ReactNode;
  /** Full-width inset panel below the content (e.g. shortcut hints). */
  footer?: ReactNode;
  /** Accessible label for the region (the panel; a compact state is read by its title). */
  label?: string;
  size?: "panel" | "compact";
  tone?: "neutral" | "error";
  className?: string;
}) {
  const classes = ["empty-state", className].filter(Boolean).join(" ");
  if (size === "compact") {
    return (
      <div
        className={classes}
        data-size="compact"
        data-tone={tone}
        role={tone === "error" ? "alert" : "status"}
      >
        {icon ? (
          <span className="empty-state-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
        <p className="empty-state-title">{title}</p>
        {description ? <p className="empty-state-description">{description}</p> : null}
        {action ? <div className="empty-state-action">{action}</div> : null}
      </div>
    );
  }
  return (
    <section className={classes} data-tone={tone} aria-label={label}>
      <div className="empty-state-content">
        {icon ? (
          <span className="empty-state-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
        <h2 className="empty-state-title">{title}</h2>
        {description ? <p className="empty-state-description">{description}</p> : null}
        {action ? <div className="empty-state-action">{action}</div> : null}
      </div>
      {footer ? <div className="empty-state-footer">{footer}</div> : null}
    </section>
  );
}

/**
 * A list that could not load. It says what failed, gives the reason the
 * bridge returned, and offers the one action that might fix it, when one
 * exists: a failure without a way out reads as a dead end.
 */
export function LoadFailed({
  title,
  message,
  onRetry,
}: {
  title: ReactNode;
  message?: ReactNode;
  /** Absent when retrying cannot help (a permanent error). */
  onRetry?: () => void;
}) {
  return (
    <EmptyState
      size="compact"
      tone="error"
      icon={<IconExclamationCircle size={22} />}
      title={title}
      description={message}
      action={
        onRetry ? (
          <button type="button" className="empty-state-button" onClick={onRetry}>
            {t("Try again")}
          </button>
        ) : undefined
      }
    />
  );
}

/**
 * A search that found nothing. The message names what was searched; the
 * button undoes the search, which is the one thing a person stuck here
 * wants to do next.
 */
export function NoMatches({ message, onClear }: { message: ReactNode; onClear?: () => void }) {
  return (
    <EmptyState
      size="compact"
      title={message}
      action={
        onClear ? (
          <button type="button" className="empty-state-button" onClick={onClear}>
            {t("Clear search")}
          </button>
        ) : undefined
      }
    />
  );
}
