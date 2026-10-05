/**
 * Cutting a character sheet into the references a video model can use.
 *
 * A sheet is nine views of one character in a 3 by 3 grid (`SHEET_LAYOUT` in
 * `portrait.ts`). It never rides to a video model whole, which would film the
 * grid (ADR-0066), but two of its cells are exactly the stack's identity
 * anchors: the middle row's front view is a portrait and its last cell is a
 * profile, and the top left full body view is the outfit reference the prompt
 * bible asks for next to the portrait. Cutting them out is free and keeps the
 * face and the clothes the sheet drew.
 *
 * The cut is by position, which is why the layout is fixed: an equal grid
 * with thin gutters. Models draw that grid faithfully but add a margin around
 * it, so the plain border is trimmed first (`gridBounds`), then the grid is
 * split in thirds and each cell shaved by a small inset to lose the gutter.
 */

import { t } from "../../i18n";
import type { BibleRole } from "./types";

/** The cells the app keeps, by index in reading order (0 is top left). */
export const SHEET_CUTS: ReadonlyArray<{ cell: number; role: BibleRole }> = [
  { cell: 0, role: "outfit" },
  { cell: 3, role: "portrait" },
  { cell: 5, role: "profile" },
];

/** How much of each side of a cell is shaved off, to lose the gutter. */
export const SHEET_INSET = 0.05;

/** A trim larger than this on any side is not a margin, it is the picture. */
const MAX_MARGIN = 0.15;

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the grid sits inside the image: the image minus the plain margin a
 * model draws around it.
 *
 * A row or column is margin while nearly all of its pixels match the corner's
 * colour. `pixels` is RGBA, row by row, as `getImageData` returns it.
 */
export function gridBounds(pixels: Uint8ClampedArray, width: number, height: number): CellRect {
  const corner = [pixels[0], pixels[1], pixels[2]];
  const plain = (index: number) =>
    Math.abs(pixels[index] - corner[0]) +
      Math.abs(pixels[index + 1] - corner[1]) +
      Math.abs(pixels[index + 2] - corner[2]) <=
    36;
  const rowIsMargin = (y: number) => {
    let matches = 0;
    for (let x = 0; x < width; x++) if (plain((y * width + x) * 4)) matches++;
    return matches >= width * 0.97;
  };
  const columnIsMargin = (x: number) => {
    let matches = 0;
    for (let y = 0; y < height; y++) if (plain((y * width + x) * 4)) matches++;
    return matches >= height * 0.97;
  };
  let top = 0;
  while (top < height * MAX_MARGIN && rowIsMargin(top)) top++;
  let bottom = height - 1;
  while (bottom > height * (1 - MAX_MARGIN) && rowIsMargin(bottom)) bottom--;
  let left = 0;
  while (left < width * MAX_MARGIN && columnIsMargin(left)) left++;
  let right = width - 1;
  while (right > width * (1 - MAX_MARGIN) && columnIsMargin(right)) right--;
  // A margin that runs to the limit on one side is a plain picture edge, not a
  // frame: keep that side whole.
  if (top >= height * MAX_MARGIN) top = 0;
  if (bottom <= height * (1 - MAX_MARGIN)) bottom = height - 1;
  if (left >= width * MAX_MARGIN) left = 0;
  if (right <= width * (1 - MAX_MARGIN)) right = width - 1;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Where cell `cell` of a 3 by 3 grid inside `bounds` is, gutter shaved off. */
export function sheetCell(bounds: CellRect, cell: number, inset = SHEET_INSET): CellRect {
  const column = cell % 3;
  const row = Math.floor(cell / 3);
  const cellWidth = bounds.width / 3;
  const cellHeight = bounds.height / 3;
  return {
    x: Math.round(bounds.x + column * cellWidth + cellWidth * inset),
    y: Math.round(bounds.y + row * cellHeight + cellHeight * inset),
    width: Math.max(1, Math.round(cellWidth * (1 - 2 * inset))),
    height: Math.max(1, Math.round(cellHeight * (1 - 2 * inset))),
  };
}

/** The grid's bounds in a loaded image, measured on a small copy for speed. */
function measureGrid(image: HTMLImageElement): CellRect {
  const whole = { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
  const scale = Math.min(1, 400 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return whole;
  context.drawImage(image, 0, 0, width, height);
  const found = gridBounds(context.getImageData(0, 0, width, height).data, width, height);
  return {
    x: Math.round(found.x / scale),
    y: Math.round(found.y / scale),
    width: Math.min(whole.width, Math.round(found.width / scale)),
    height: Math.min(whole.height, Math.round(found.height / scale)),
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t("The character sheet could not be read.")));
    image.src = src;
  });
}

/**
 * The kept cells of a sheet, as base64 PNG without the data URI prefix.
 *
 * The source is a data URI rather than the gallery URL so the canvas is never
 * tainted: the asset protocol is another origin as far as the webview is
 * concerned, and a tainted canvas refuses to export.
 */
export async function cutSheet(
  dataUri: string,
): Promise<Array<{ role: BibleRole; base64: string }>> {
  const image = await loadImage(dataUri);
  const bounds = measureGrid(image);
  const cuts: Array<{ role: BibleRole; base64: string }> = [];
  for (const { cell, role } of SHEET_CUTS) {
    const rect = sheetCell(bounds, cell);
    const canvas = document.createElement("canvas");
    canvas.width = rect.width;
    canvas.height = rect.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("The character sheet could not be read."));
    context.drawImage(
      image,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    );
    cuts.push({ role, base64: canvas.toDataURL("image/png").split(",")[1] ?? "" });
  }
  return cuts;
}
