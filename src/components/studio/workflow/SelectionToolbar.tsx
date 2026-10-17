// The bar over a selection (ComfyUI's selection toolbox): run what is
// selected, set it aside or back, duplicate, line up, delete. It appears
// above the selected steps and follows them.

import { NodeToolbar, Position, useStore } from "@xyflow/react";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconColorPalette } from "central-icons/IconColorPalette";
import { IconColumns3 } from "central-icons/IconColumns3";
import { IconEyeSlash } from "central-icons/IconEyeSlash";
import { IconLayoutAlignLeft } from "central-icons/IconLayoutAlignLeft";
import { IconLayoutAlignTop } from "central-icons/IconLayoutAlignTop";
import { IconPin } from "central-icons/IconPin";
import { IconPlay } from "central-icons/IconPlay";
import { IconSkip } from "central-icons/IconSkip";
import { IconSquarePlaceholderDashed } from "central-icons/IconSquarePlaceholderDashed";
import { IconSquareBehindSquare1 } from "central-icons/IconSquareBehindSquare1";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { type ReactNode, useState } from "react";
import { t } from "../../../lib/i18n";
import type { Alignment } from "../../../lib/studio/workflow/arrange";
import { NODE_COLORS } from "../../../lib/studio/workflow/schema";

/** Pixels the bar needs above a selection to be drawn there. */
const ROOM_ABOVE = 56;

export function colourLabel(color: (typeof NODE_COLORS)[number]): string {
  switch (color) {
    case "rose":
      return t("Rose");
    case "amber":
      return t("Amber");
    case "green":
      return t("Green");
    case "blue":
      return t("Blue");
    case "violet":
      return t("Violet");
  }
}

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
  allPinned,
  onLayout,
  onRun,
  onSetAside,
  onDuplicate,
  onFrame,
  onAlign,
  onDistribute,
  onDelete,
}: {
  selected: string[];
  /** Every selected step is already set aside: the button brings them back. */
  allSetAside: boolean;
  /** Every selected step is pinned: the button unpins them. */
  allPinned: boolean;
  /** Collapse, pin or tint every selected step. */
  onLayout: (change: { collapsed?: boolean; pinned?: boolean; color?: string }) => void;
  onRun: () => void;
  onSetAside: (mode: "bypass" | "mute" | undefined) => void;
  onDuplicate: () => void;
  /** Draw a frame about the selection (⌘G). */
  onFrame: () => void;
  onAlign: (to: Alignment) => void;
  onDistribute: () => void;
  onDelete: () => void;
}) {
  const [colouring, setColouring] = useState(false);
  // Above the selection, unless the selection touches the top of the canvas:
  // then below it, or the bar would be drawn out of sight.
  const roomAbove = useStore((state) => {
    const [, offsetY, zoom] = state.transform;
    let top = Number.POSITIVE_INFINITY;
    for (const id of selected) {
      const node = state.nodeLookup.get(id);
      if (node) top = Math.min(top, node.internals.positionAbsolute.y);
    }
    return top * zoom + offsetY > ROOM_ABOVE;
  });
  if (selected.length === 0) return null;
  const several = selected.length > 1;
  return (
    <NodeToolbar
      nodeId={selected}
      isVisible
      position={roomAbove ? Position.Top : Position.Bottom}
      offset={12}
    >
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
        <ToolButton label={t("Frame the selected steps")} onClick={onFrame}>
          <IconSquarePlaceholderDashed size={15} />
        </ToolButton>
        <ToolButton
          label={allPinned ? t("Unpin") : t("Pin in place")}
          onClick={() => onLayout({ pinned: !allPinned })}
        >
          <IconPin size={15} />
        </ToolButton>
        <ToolButton label={t("Collapse")} onClick={() => onLayout({ collapsed: true })}>
          <IconChevronDownSmall size={15} />
        </ToolButton>
        <ToolButton label={t("Colour")} onClick={() => setColouring((open) => !open)}>
          <IconColorPalette size={15} />
        </ToolButton>
        {colouring ? (
          <span className="studio-selection-swatches">
            {NODE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className="studio-swatch"
                data-color={color}
                aria-label={colourLabel(color)}
                title={colourLabel(color)}
                onClick={() => onLayout({ color })}
              />
            ))}
            <button
              type="button"
              className="studio-swatch"
              aria-label={t("No colour")}
              title={t("No colour")}
              onClick={() => onLayout({ color: undefined })}
            />
          </span>
        ) : null}
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
