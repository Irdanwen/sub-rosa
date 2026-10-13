import type { ReactNode } from "react";

/**
 * A sentence explaining why the last action failed, next to the control
 * that ran it. It is announced when it appears (role="alert"): a red line
 * a screen reader never reads is a failure nobody hears about.
 *
 * A failure that blocks a whole surface is an `InlineNotice`; one that
 * empties a list is `LoadFailed`.
 */
export function ErrorMessage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={["error-message", className].filter(Boolean).join(" ")} role="alert">
      {children}
    </p>
  );
}
