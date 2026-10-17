// The bar over a selection (ComfyUI's selection toolbox): run what is
// selected, set it aside or back, duplicate, line up, delete. It appears
// above the selected steps and follows them.

import { NodeToolbar, Position } from "@xyflow/react";
import { IconColumns3 } from "central-icons/IconColumns3";
import { IconEyeSlash } from "central-icons/IconEyeSlash";
import { IconLayoutAlignLeft } from "central-icons/IconLayoutAlignLeft";
import { IconLayoutAlignTop } from "central-icons/IconLayoutAlignTop";
import { IconPlay } from "central-icons/IconPlay";
import { IconSkip } from "central-icons/IconSkip";
import { IconSquareBehindSquare1 } from "central-icons/IconSquareBehindSquare1";
import { IconTrashCan } from "central-icons/IconTrashCan";
import type { ReactNode } from "react";
import { t } from "../../../lib/i18n";
import type { Alignment } from "../../../lib/studio/workflow/arrange";

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="studio-icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function SelectionToolbar({
  selected,
  allSetAside,
  onRun,
  onSetAside,
  onDuplicate,
  onAlign,
  onDistribute,
  onDelete,
}: {
  selected: string[];
  /** Every selected step is already set aside: the button brings them back. */
  allSetAside: boolean;
  onRun: () => void;
  onSetAside: (mode: "bypass" | "mute" | undefined) => void;
  onDuplicate: () => void;
  onAlign: (to: Alignment) => void;
  onDistribute: () => void;
  onDelete: () => void;
}) {
  if (selected.length === 0) return null;
  const several = selected.length > 1;
  return (
    <NodeToolbar nodeId={selected} isVisible position={Position.Top} offset={12}>
      <div className="studio-selection-bar" role="toolbar" aria-label={t("Selected steps")}>
        <ToolButton label={t("Run the selected steps")} onClick={onRun}>
          <IconPlay size={15} />
        </ToolButton>
        <ToolButton
          label={allSetAside ? t("Run the selected steps again") : t("Skip the selected steps")}
          onClick={() => onSetAside(allSetAside ? undefined : "bypass")}
        >
          <IconSkip size={15} />
        </ToolButton>
        {allSetAside ? null : (
          <ToolButton label={t("Switch the selected steps off")} onClick={() => onSetAside("mute")}>
            <IconEyeSlash size={15} />
          </ToolButton>
        )}
        <ToolButton label={t("Duplicate")} onClick={onDuplicate}>
          <IconSquareBehindSquare1 size={15} />
        </ToolButton>
        {several ? (
          <>
            <ToolButton label={t("Align left")} onClick={() => onAlign("left")}>
              <IconLayoutAlignLeft size={15} />
            </ToolButton>
            <ToolButton label={t("Align top")} onClick={() => onAlign("top")}>
              <IconLayoutAlignTop size={15} />
            </ToolButton>
          </>
        ) : null}
        {selected.length > 2 ? (
          <ToolButton label={t("Spread evenly")} onClick={onDistribute}>
            <IconColumns3 size={15} />
          </ToolButton>
        ) : null}
        <ToolButton label={t("Delete")} onClick={onDelete}>
          <IconTrashCan size={15} />
        </ToolButton>
      </div>
    </NodeToolbar>
  );
}
