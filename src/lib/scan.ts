/**
 * Scanning paper into a note, on the phone (`src-tauri/src/scan/`).
 *
 * The platform's own document camera does the capture (VisionKit on iOS, ML
 * Kit on Android); Rust writes the recognized text into a new note and keeps
 * the PDF beside it. The desktop has no document camera, so nothing here is
 * offered there.
 */

import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";
import { intlLocale, t } from "./i18n";

export type DocumentScanResult = {
  noteId: string;
  pages: number;
  /** The recognized text, plain, for a chat attachment. */
  text: string;
};

/** True only inside the iOS or Android app, where a document camera exists. */
export function supportsDocumentScan(): boolean {
  try {
    const name = platform();
    return name === "ios" || name === "android";
  } catch {
    return false;
  }
}

/** The note's title: what it is and when, in the reader's language. */
export function scanTitle(now: Date = new Date()): string {
  const date = new Intl.DateTimeFormat(intlLocale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  return t("Scan of {date}", { date });
}

/**
 * Opens the document camera and writes what it read into a new note. Resolves
 * to `null` when the person closes the camera without keeping a page.
 */
export async function scanDocument(): Promise<DocumentScanResult | null> {
  return invoke<DocumentScanResult | null>("document_scan", {
    request: { title: scanTitle(), pageHeading: t("Page {n}") },
  });
}

export function scanPdfExists(noteId: string): Promise<boolean> {
  return invoke<boolean>("document_scan_pdf_exists", { noteId });
}

export function shareScanPdf(noteId: string): Promise<void> {
  return invoke<void>("document_scan_share", { noteId });
}

/** Whether this note was scanned on this device and still has its PDF. */
export function useScanPdf(noteId: string | undefined): boolean {
  const [exists, setExists] = useState(false);
  useEffect(() => {
    setExists(false);
    if (!noteId || !supportsDocumentScan()) return;
    let cancelled = false;
    scanPdfExists(noteId)
      .then((found) => {
        if (!cancelled) setExists(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [noteId]);
  return exists;
}
