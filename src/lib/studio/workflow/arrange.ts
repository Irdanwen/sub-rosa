// Lining steps up (ComfyUI's align and distribute): a selection aligned on
// one edge or centre, or spread so the gaps between them are equal.

export interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Alignment = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

/** New positions (top left corners) for the boxes, aligned. */
export function align(boxes: readonly Box[], to: Alignment): Map<string, { x: number; y: number }> {
  const moved = new Map<string, { x: number; y: number }>();
  if (boxes.length < 2) return moved;
  const left = Math.min(...boxes.map((box) => box.x));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const top = Math.min(...boxes.map((box) => box.y));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  for (const box of boxes) {
    let { x, y } = box;
    if (to === "left") x = left;
    if (to === "right") x = right - box.width;
    if (to === "centerX") x = (left + right) / 2 - box.width / 2;
    if (to === "top") y = top;
    if (to === "bottom") y = bottom - box.height;
    if (to === "centerY") y = (top + bottom) / 2 - box.height / 2;
    moved.set(box.id, { x, y });
  }
  return moved;
}

/** New positions spreading the boxes along an axis with equal gaps, the two
 * outermost staying where they are. */
export function distribute(
  boxes: readonly Box[],
  axis: "horizontal" | "vertical",
): Map<string, { x: number; y: number }> {
  const moved = new Map<string, { x: number; y: number }>();
  if (boxes.length < 3) return moved;
  const horizontal = axis === "horizontal";
  const start = (box: Box) => (horizontal ? box.x : box.y);
  const size = (box: Box) => (horizontal ? box.width : box.height);
  const sorted = [...boxes].sort((a, b) => start(a) - start(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = start(last) + size(last) - start(first);
  const filled = sorted.reduce((sum, box) => sum + size(box), 0);
  const gap = (span - filled) / (sorted.length - 1);
  let cursor = start(first);
  for (const box of sorted) {
    moved.set(box.id, horizontal ? { x: cursor, y: box.y } : { x: box.x, y: cursor });
    cursor += size(box) + gap;
  }
  return moved;
}
