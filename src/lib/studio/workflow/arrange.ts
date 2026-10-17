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

/**
 * Arrange (ComfyUI's arrange popover, for a graph that flows left to right):
 * each step goes in the column of its longest chain of inputs, steps of a
 * column stack from the top in their current vertical order, and `gap`
 * spaces both. Positions only: nothing else about the graph changes.
 */
export function layered(
  boxes: readonly Box[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  gap: number,
): Map<string, { x: number; y: number }> {
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    parents.set(edge.target, [...(parents.get(edge.target) ?? []), edge.source]);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(-1, ...(parents.get(id) ?? []).map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  const columns: Box[][] = [];
  for (const box of boxes) {
    const column = depthOf(box.id);
    columns[column] = [...(columns[column] ?? []), box];
  }
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const moved = new Map<string, { x: number; y: number }>();
  let x = left;
  for (const column of columns) {
    if (!column) continue;
    let y = top;
    for (const box of [...column].sort((a, b) => a.y - b.y)) {
      moved.set(box.id, { x, y });
      y += box.height + gap;
    }
    x += Math.max(...column.map((box) => box.width)) + gap;
  }
  return moved;
}
