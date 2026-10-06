import { markOf, type StudioLibrary } from "./library";
import type { ArtifactKind, StudioArtifact } from "./types";

/** The gallery's views. A kind view (all, image, video, audio) shows what is
 * in no folder; a folder shows its own; favourites and hidden cut across. */
export type GalleryView =
  | "all"
  | "image"
  | "video"
  | "audio"
  | "favorites"
  | "collections"
  | "hidden";

export const AUDIO_KINDS: ArtifactKind[] = ["music", "speech", "sfx"];

export type GalleryFilter = {
  view: GalleryView;
  /** The open folder, for the `collections` view. */
  collectionId?: string | null;
  query?: string;
};

/** What the gallery shows, shared by the phone and the desktop. A file filed
 * in a folder leaves the kind views, as a note filed in a folder leaves the
 * notes list; a search still finds it, so it is never out of reach. */
export function visibleArtifacts(
  items: StudioArtifact[],
  library: StudioLibrary,
  { view, collectionId = null, query = "" }: GalleryFilter,
): StudioArtifact[] {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => {
    const mark = markOf(library, item);
    if (view === "hidden") {
      if (!mark?.hidden) return false;
    } else if (mark?.hidden) {
      return false;
    }
    if (view === "image" && item.kind !== "image") return false;
    if (view === "video" && item.kind !== "video") return false;
    if (view === "audio" && !AUDIO_KINDS.includes(item.kind)) return false;
    if (view === "favorites" && !mark?.favorite) return false;
    if (view === "collections" && (!collectionId || mark?.collectionId !== collectionId)) {
      return false;
    }
    if (!needle) return !(isKindView(view) && mark?.collectionId);
    return [item.prompt, item.model, item.title].some((field) =>
      (field ?? "").toLowerCase().includes(needle),
    );
  });
}

function isKindView(view: GalleryView) {
  return view === "all" || view === "image" || view === "video" || view === "audio";
}
