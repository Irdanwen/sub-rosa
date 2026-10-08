// Saving a chart or a table out of a reply (ADR-0086). The webview draws the
// file, because only it holds the rendered chart with its resolved theme
// colours; Rust delivers it the way a conversation export is delivered
// (desktop save dialog, phone share sheet), so no path crosses IPC.

import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export type ChatDataFormat = "png" | "svg" | "csv";

/** `data` is text for svg and csv, base64 for png. */
export function exportChatData(name: string, format: ChatDataFormat, data: string) {
  return invoke<{ path: string | null; bytes: number; shared: boolean }>("export_chat_data", {
    request: { name, format, data },
  });
}

/** The presentation properties a chart's marks and text take from CSS. A
 * standalone file has no stylesheet, so each is written onto the element. */
const INLINED = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
] as const;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The live chart as a self-contained SVG document: theme colours resolved to
 * values, a solid background, and the title drawn above the plot so the file
 * still says what it shows once it has left the reply.
 */
export function standaloneSvg(svg: SVGSVGElement, title?: string): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const sources = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const targets = [clone, ...Array.from(clone.querySelectorAll("*"))];
  sources.forEach((source, index) => {
    const target = targets[index];
    if (!(target instanceof Element)) return;
    const computed = window.getComputedStyle(source);
    const style = INLINED.map((property) => {
      const value = computed.getPropertyValue(property);
      return value ? `${property}:${value}` : "";
    })
      .filter(Boolean)
      .join(";");
    if (style) target.setAttribute("style", style);
    target.removeAttribute("class");
  });
  const width = Number(svg.getAttribute("width")) || 560;
  const height = Number(svg.getAttribute("height")) || 280;
  const header = title ? 32 : 0;
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height + header));
  root.setAttribute("viewBox", `0 0 ${width} ${height + header}`);
  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  const surface = window.getComputedStyle(svg.parentElement ?? svg).getPropertyValue("--card");
  background.setAttribute("fill", surface.trim() || "white");
  root.appendChild(background);
  const ink = window.getComputedStyle(svg).getPropertyValue("color").trim();
  if (title) {
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", "12");
    text.setAttribute("y", "22");
    text.setAttribute(
      "style",
      `font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:600;fill:${ink || "black"}`,
    );
    text.textContent = title;
    root.appendChild(text);
  }
  const body = document.createElementNS(SVG_NS, "g");
  body.setAttribute("transform", `translate(0 ${header})`);
  for (const child of Array.from(clone.childNodes)) body.appendChild(child);
  root.appendChild(body);
  return new XMLSerializer().serializeToString(root);
}

/** Rasterizes a standalone SVG at twice its size, as base64 PNG bytes. */
export function svgToPngBase64(svgText: string, scaleFactor = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scaleFactor);
      canvas.height = Math.round(image.height * scaleFactor);
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error(t("The chart could not be drawn.")));
        return;
      }
      context.scale(scaleFactor, scaleFactor);
      context.drawImage(image, 0, 0);
      resolve(canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""));
    };
    image.onerror = () => reject(new Error(t("The chart could not be drawn.")));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  });
}
