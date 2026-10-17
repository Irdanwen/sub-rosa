// "Arrange" (ComfyUI's arrange popover): lay the steps out in columns by
// what feeds what, with a slider for the space between them that moves the
// canvas as it slides. Undo takes the whole arrangement back in one step.

import { useId } from "react";
import { t } from "../../../lib/i18n";

export const ARRANGE_GAP = { min: 24, max: 160, initial: 56 };

export function ArrangePopover({
  gap,
  onGap,
  onDone,
  onCancel,
}: {
  gap: number;
  onGap: (gap: number) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const sliderId = useId();
  return (
    <section className="studio-arrange" aria-label={t("Arrange the steps")}>
      <label htmlFor={sliderId}>{t("Space between steps")}</label>
      <input
        id={sliderId}
        type="range"
        min={ARRANGE_GAP.min}
        max={ARRANGE_GAP.max}
        step={4}
        value={gap}
        onChange={(event) => onGap(Number(event.target.value))}
      />
      <div className="studio-arrange-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t("Put back")}
        </button>
        <button type="button" className="studio-primary-button" onClick={onDone}>
          {t("Done")}
        </button>
      </div>
    </section>
  );
}
