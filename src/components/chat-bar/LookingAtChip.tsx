import { t } from "../../lib/i18n";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconEyeOpen } from "central-icons/IconEyeOpen";
import {
  type LookingAt,
  lookingAtChipDetail,
  lookingAtChipLabel,
} from "../../lib/screen-awareness";

/** "What I'm looking at", shown before sending and removable (ADR-0094). */
export function LookingAtChip({ value, onRemove }: { value: LookingAt; onRemove: () => void }) {
  const detail = lookingAtChipDetail(value);
  return (
    <div className="looking-at-chip">
      <IconEyeOpen size={14} aria-hidden />
      <span className="looking-at-chip-text">
        <span className="looking-at-chip-label">{lookingAtChipLabel(value)}</span>
        {detail ? <span className="looking-at-chip-detail">{detail}</span> : null}
      </span>
      <button
        type="button"
        className="looking-at-chip-remove"
        aria-label={t("Remove what I’m looking at")}
        onClick={onRemove}
      >
        <IconCrossSmall size={14} aria-hidden />
      </button>
    </div>
  );
}
