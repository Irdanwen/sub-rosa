// Several tries of one instruction, side by side: pick the one to continue
// from. The others stay in the gallery and in the filmstrip.

import { useArtifactPreview } from "../../../lib/artifact-media";
import { t } from "../../../lib/i18n";
import { versionTitle } from "../../../lib/studio/retouch/labels";
import type { PendingStep } from "../../../lib/studio/retouch/useRetouchSession";
import type { StudioArtifact } from "../../../lib/studio/types";
import { Dialog } from "../../ui/Dialog";

export function RetouchVariants({
  open,
  variants,
  pending,
  prompt,
  onPick,
  onClose,
}: {
  open: boolean;
  variants: StudioArtifact[];
  pending: PendingStep[];
  prompt: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const total = variants.length + pending.length;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("Pick a try to continue from")}
      description={prompt}
      width="min(1080px, 92vw)"
      className="retouch-variants-dialog"
      footer={
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t("Decide later")}
        </button>
      }
    >
      <div className="retouch-sheet" data-count={total}>
        {variants.map((variant) => (
          <VariantTile key={variant.id} variant={variant} onPick={onPick} />
        ))}
        {pending.map((step) => (
          <div key={step.key} className="retouch-sheet-pending" aria-hidden>
            <span>{t("Retouching")}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function VariantTile({
  variant,
  onPick,
}: {
  variant: StudioArtifact;
  onPick: (id: string) => void;
}) {
  const preview = useArtifactPreview(variant);
  return (
    <button type="button" className="retouch-sheet-tile" onClick={() => onPick(variant.id)}>
      {preview ? <img src={preview} alt="" draggable={false} /> : null}
      <span className="retouch-sheet-label">
        {t("Continue from {title}", { title: versionTitle(variant) })}
      </span>
    </button>
  );
}
