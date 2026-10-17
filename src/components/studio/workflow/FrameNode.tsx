// A frame on the canvas (ComfyUI's group): a tinted rectangle with a title,
// drawn behind the steps. Its title bar drags it, with the steps inside;
// its corners resize it; its bar tints it, selects what it holds or sets
// that aside. Clicks on its body go through to the canvas.

import { type Node as FlowNode, NodeResizer, NodeToolbar, Position } from "@xyflow/react";
import { IconColorPalette } from "central-icons/IconColorPalette";
import { IconPlay } from "central-icons/IconPlay";
import { IconSelectLassoDashed } from "central-icons/IconSelectLassoDashed";
import { IconSkip } from "central-icons/IconSkip";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useState } from "react";
import { t } from "../../../lib/i18n";
import { NODE_COLORS, type WorkflowFrame } from "../../../lib/studio/workflow/schema";
import { colourLabel } from "./SelectionToolbar";

export interface FrameNodeData extends Record<string, unknown> {
  frame: WorkflowFrame;
  readOnly: boolean;
  /** Every step inside is already skipped: the button brings them back. */
  contentsSkipped: boolean;
  onFrameChange: (id: string, change: Partial<Pick<WorkflowFrame, "label" | "color">>) => void;
  onSelectContents: (id: string) => void;
  onSkipContents: (id: string, skip: boolean) => void;
  onRemoveFrame: (id: string) => void;
}

export type FrameFlowNode = FlowNode<FrameNodeData, "frame">;

/** The smallest a frame may be drawn: room for its title. */
export const FRAME_MIN = { width: 200, height: 120 };

export function FrameNode({ data, selected }: { data: FrameNodeData; selected?: boolean }) {
  const { frame, readOnly } = data;
  const [renaming, setRenaming] = useState(false);
  const [colouring, setColouring] = useState(false);
  return (
    <div className="studio-frame" data-color={frame.color}>
      {readOnly ? null : (
        <NodeResizer
          isVisible={selected}
          minWidth={FRAME_MIN.width}
          minHeight={FRAME_MIN.height}
          lineClassName="studio-frame-resize-line"
          handleClassName="studio-frame-resize-handle"
        />
      )}
      {selected && !readOnly ? (
        <NodeToolbar
          isVisible
          position={Position.Top}
          align="start"
          offset={8}
          // The bar takes its frame's depth plus one, which for a frame drawn
          // behind the steps is under the canvas itself: lift it to a step's.
          style={{ zIndex: 1 }}
        >
          <div className="studio-selection-bar" role="toolbar" aria-label={t("Frame actions")}>
            <button
              type="button"
              className="studio-icon-button"
              aria-label={t("Select the steps in this frame")}
              title={t("Select the steps in this frame")}
              onClick={() => data.onSelectContents(frame.id)}
            >
              <IconSelectLassoDashed size={15} />
            </button>
            <button
              type="button"
              className="studio-icon-button"
              aria-label={
                data.contentsSkipped
                  ? t("Run the steps in this frame again")
                  : t("Skip the steps in this frame")
              }
              title={
                data.contentsSkipped
                  ? t("Run the steps in this frame again")
                  : t("Skip the steps in this frame")
              }
              onClick={() => data.onSkipContents(frame.id, !data.contentsSkipped)}
            >
              {data.contentsSkipped ? <IconPlay size={15} /> : <IconSkip size={15} />}
            </button>
            <button
              type="button"
              className="studio-icon-button"
              aria-label={t("Colour")}
              title={t("Colour")}
              onClick={() => setColouring((open) => !open)}
            >
              <IconColorPalette size={15} />
            </button>
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
                    onClick={() => data.onFrameChange(frame.id, { color })}
                  />
                ))}
                <button
                  type="button"
                  className="studio-swatch"
                  aria-label={t("No colour")}
                  title={t("No colour")}
                  onClick={() => data.onFrameChange(frame.id, { color: undefined })}
                />
              </span>
            ) : null}
            <button
              type="button"
              className="studio-icon-button"
              aria-label={t("Remove the frame, keep its steps")}
              title={t("Remove the frame, keep its steps")}
              onClick={() => data.onRemoveFrame(frame.id)}
            >
              <IconTrashCan size={15} />
            </button>
          </div>
        </NodeToolbar>
      ) : null}
      <div className="studio-frame-title">
        {renaming ? (
          <input
            className="studio-frame-title-input nodrag"
            aria-label={t("Frame name")}
            defaultValue={frame.label}
            // biome-ignore lint/a11y/noAutofocus: the field opens because the person asked to rename.
            autoFocus
            onBlur={(event) => {
              data.onFrameChange(frame.id, { label: event.currentTarget.value.trim() });
              setRenaming(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="studio-frame-title-text"
            title={readOnly ? undefined : t("Double-click to rename")}
            onDoubleClick={() => {
              if (!readOnly) setRenaming(true);
            }}
          >
            {frame.label || t("Untitled frame")}
          </button>
        )}
      </div>
    </div>
  );
}
