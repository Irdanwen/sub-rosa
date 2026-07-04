import type { ReactNode } from "react";

/** Shared two-column shell for the generation views: a controls column on
 * the left, the output surface on the right. Every studio uses it so the
 * image, video, and music tabs read as one tool. */
export function GenerationLayout({
  controls,
  action,
  children,
}: {
  controls: ReactNode;
  /** Primary call to action pinned under the controls. */
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="studio-generation">
      <aside className="studio-controls">
        <div className="studio-controls-fields">{controls}</div>
        <div className="studio-controls-action">{action}</div>
      </aside>
      <section className="studio-output">{children}</section>
    </div>
  );
}
