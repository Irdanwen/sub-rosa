import { invoke } from "@tauri-apps/api/core";

/** What became of something shared in through the share sheet (ADR-0048). */
export type SharedImportDto = {
  /** "platform": a video page this device cannot read, handed back as `url`. */
  kind: "link" | "file" | "text" | "platform";
  /** The note that was made, when one was made on the spot (a file, a text). */
  noteId?: string;
  /** The fetch that was started, for a link; the notes list shows it. */
  ingestId?: string;
  /** The link, for a video page this device cannot read (ADR-0054). */
  url?: string;
};

/** Read one manifest the share extension left in the app group inbox and act on it. */
export async function importSharedItem(itemId: string): Promise<SharedImportDto> {
  return invoke<SharedImportDto>("import_shared_item", { request: { itemId } });
}
