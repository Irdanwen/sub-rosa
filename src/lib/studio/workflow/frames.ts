// Frames (ComfyUI's groups): a titled, tinted rectangle behind steps that
// belong together. A step is in a frame by where it stands, not by a link:
// moving the frame moves the steps inside it, and a step dragged out simply
// leaves. Frames are layout: a run never sees them.

import type { WorkflowFrame } from "./schema";

/** Room around the steps a new frame is drawn about, and above for its title. */
const PADDING = 32;
const TITLE = 36;

export interface FrameBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A frame drawn about these steps. */
export function frameAround(
  boxes: readonly FrameBox[],
  label: string,
  newId: () => string = () => crypto.randomUUID(),
): WorkflowFrame | undefined {
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return {
    id: newId(),
    label,
    x: left - PADDING,
    y: top - PADDING - TITLE,
    width: right - left + PADDING * 2,
    height: bottom - top + PADDING * 2 + TITLE,
  };
}

/** The steps a frame holds: those whose centre is inside it. */
export function stepsInFrame(frame: WorkflowFrame, boxes: readonly FrameBox[]): string[] {
  return boxes
    .filter((box) => {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      return (
        cx >= frame.x &&
        cx <= frame.x + frame.width &&
        cy >= frame.y &&
        cy <= frame.y + frame.height
      );
    })
    .map((box) => box.id);
}

/** Frames read from a stored graph or a file: anything malformed is left out. */
export function cleanFrames(raw: unknown): WorkflowFrame[] {
  if (!Array.isArray(raw)) return [];
  const frames: WorkflowFrame[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const frame = entry as Record<string, unknown>;
    const numbers = [frame.x, frame.y, frame.width, frame.height].map(Number);
    if (typeof frame.id !== "string" || numbers.some((value) => !Number.isFinite(value))) continue;
    const [x, y, width, height] = numbers;
    if (width <= 0 || height <= 0) continue;
    frames.push({
      id: frame.id,
      label: typeof frame.label === "string" ? frame.label : "",
      x,
      y,
      width,
      height,
      ...(typeof frame.color === "string" ? { color: frame.color } : {}),
    });
  }
  return frames;
}
