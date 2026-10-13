import { t } from "../../lib/i18n";

/**
 * The one way a list says it is loading: placeholder rows the shape of the
 * rows to come, breathing (a static grey bar reads as broken). It is for
 * lists whose length is unknown and short; a render that takes minutes
 * waits behind the Veil instead, never behind a skeleton (CONTEXT.md).
 *
 * The rows are decorative; a single status line carries the meaning for
 * assistive technology.
 */
export function ShimmerRows({ count = 2, label }: { count?: number; label?: string }) {
  return (
    <div className="shimmer-rows" role="status" aria-label={label ?? t("Loading")}>
      {Array.from({ length: count }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={index} className="shimmer-row" aria-hidden>
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line" />
        </div>
      ))}
    </div>
  );
}
