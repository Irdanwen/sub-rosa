/**
 * Bringing a film home: the rescue window before Videomaker is removed.
 *
 * See `docs/plan-films-locaux-2026-08-24.md`. Videomaker is a remote service
 * that owns films the app only borrows, so the last thing the fork does with it
 * is empty it: masters, rendered shots and storyboard frames become gallery
 * artifacts, and everything that was only ever text - the brief, the director
 * transcript, the shot list - becomes a note.
 *
 * Two decisions worth stating, because both look arbitrary from the outside.
 *
 * **A film comes home as a note, not as a new kind of thing.** That is the
 * import doctrine (ADR-0026) applied to a service instead of a file: the moment
 * it is a note it is searchable, readable by the agent, and eligible for memory
 * extraction, and it keeps all of that after the code that produced it is gone.
 *
 * **Artifacts are referenced by file name, never by path.** The file name is
 * the gallery's artifact id, and it survives everything a path does not - a
 * different machine, a reinstall, the iOS container moving. A note that
 * outlives the feature must not carry a path that outlives nothing.
 */

import {
  type BroughtHomeFilmDto,
  type BroughtHomePieceDto,
  createNote,
  updateNote,
  videomakerBringHome,
} from "../tauri";
import { registerDownloadedArtifact } from "../studio/artifacts";

/** Rust emits one of these per downloaded piece. See `BRING_HOME_EVENT`. */
export const BRING_HOME_EVENT = "june://videomaker-bring-home";

export type BringHomeProgress = { slug: string; downloaded: number; label: string };

/**
 * Subscribe to rescue progress. Returns the unsubscribe.
 *
 * Dynamically imported and failure-tolerant, like the other film subscriptions:
 * in a plain browser it simply never fires rather than throwing.
 */
export function listenBringHome(handler: (progress: BringHomeProgress) => void): () => void {
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  void import("@tauri-apps/api/event")
    .then((api) =>
      api.listen<BringHomeProgress>(BRING_HOME_EVENT, (event) => {
        if (!cancelled) handler(event.payload);
      }),
    )
    .then((stop) => {
      if (cancelled) stop?.();
      else unlisten = stop;
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/**
 * Slug → note id for films already rescued.
 *
 * localStorage, like the gallery index it sits next to: this is bookkeeping for
 * a one-off migration, not state worth a table for a feature being deleted.
 * Clearing it costs a duplicate note on a second run, which is recoverable;
 * a table would cost a migration that R4 would then have to remove.
 */
export const BROUGHT_HOME_STORAGE_KEY = "os-june:films-brought-home";

type BroughtHomeIndex = Record<string, string>;

function readIndex(): BroughtHomeIndex {
  try {
    const raw = window.localStorage.getItem(BROUGHT_HOME_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function writeIndex(index: BroughtHomeIndex): void {
  try {
    window.localStorage.setItem(BROUGHT_HOME_STORAGE_KEY, JSON.stringify(index));
  } catch {
    // A full quota must not lose the film that was just downloaded. The worst
    // case is a duplicate note next time, which the user can delete.
  }
}

/** The note a film was rescued into, if it already was. */
export function broughtHomeNoteId(slug: string): string | undefined {
  return readIndex()[slug];
}

/** Every slug already rescued on this install. */
export function broughtHomeSlugs(): string[] {
  return Object.keys(readIndex());
}

function rememberBroughtHome(slug: string, noteId: string): void {
  writeIndex({ ...readIndex(), [slug]: noteId });
}

/** The gallery kind a downloaded piece belongs in. */
function artifactKind(piece: BroughtHomePieceDto): "video" | "image" {
  return piece.kind === "frame" ? "image" : "video";
}

function heading(piece: BroughtHomePieceDto): string {
  if (piece.kind === "master") return "Final cut";
  const shot = piece.shotId ? `Shot ${piece.shotId}` : "Shot";
  return piece.kind === "frame" ? `${shot}, storyboard frame` : shot;
}

function seconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  return ` (${Math.round(value * 10) / 10} s)`;
}

/**
 * The note a rescued film becomes. Pure, so the shape is testable without a
 * backend, a gallery, or a running studio.
 */
export function composeFilmNote(film: BroughtHomeFilmDto): { title: string; markdown: string } {
  const lines: string[] = [];

  lines.push(`# ${film.title}`, "");
  lines.push(
    "Brought home from the film studio before it was removed. The clips below are in the Studio gallery.",
    "",
  );
  // Provenance in the note itself, not only in the rescue index: the index is
  // localStorage and can be cleared, and this note has to still say what it is
  // long after the feature that produced it stops existing.
  lines.push(`Film \`${film.slug}\`.`, "");

  const facts: string[] = [];
  if (film.createdAt) facts.push(`Created ${film.createdAt}`);
  if (film.state) facts.push(`State ${film.state}`);
  if (typeof film.spentDiem === "number" && film.spentDiem > 0) {
    facts.push(`Spent ${Math.round(film.spentDiem * 100) / 100}`);
  }
  if (facts.length > 0) lines.push(facts.join(" · "), "");

  if (film.brief?.trim()) {
    lines.push("## Brief", "", film.brief.trim(), "");
  }

  const master = film.pieces.find((piece) => piece.kind === "master");
  const shots = film.pieces.filter((piece) => piece.kind !== "master");

  if (master) {
    lines.push("## Final cut", "", `- \`${master.fileName}\``, "");
  }

  if (shots.length > 0) {
    lines.push("## Shots", "");
    let scene: string | undefined;
    for (const piece of shots) {
      const pieceScene = piece.sceneTitle ?? undefined;
      if (pieceScene && pieceScene !== scene) {
        scene = pieceScene;
        lines.push(`### ${scene}`, "");
      }
      lines.push(
        `- **${heading(piece)}**${seconds(piece.durationSeconds)} - \`${piece.fileName}\``,
      );
      if (piece.prompt?.trim()) lines.push(`  > ${piece.prompt.trim()}`);
    }
    lines.push("");
  }

  if (film.transcript.length > 0) {
    lines.push("## Direction", "");
    for (const [role, content] of film.transcript) {
      lines.push(`**${role === "user" ? "You" : "The studio"}:** ${content}`, "");
    }
  }

  if (film.problems.length > 0) {
    lines.push("## What did not come home", "");
    for (const problem of film.problems) lines.push(`- ${problem}`);
    lines.push("");
  }

  return { title: film.title, markdown: `${lines.join("\n").trimEnd()}\n` };
}

export interface BringFilmHomeResult {
  noteId: string;
  /** Already rescued: nothing was downloaded and no second note was written. */
  alreadyHome: boolean;
  artifactCount: number;
  problems: string[];
}

/**
 * Rescue one film: download it, index what landed, write the note.
 *
 * Re-runnable, in two different senses. By default a film already rescued
 * returns its existing note untouched rather than downloading a second copy -
 * the studio bills nothing for an export, but a duplicated 200 MB master in the
 * gallery is a real cost. With `force`, it downloads again and rewrites the
 * same note: that is the path for a partial rescue, where a shot's signed URL
 * had expired the first time and the studio is still up to try again.
 *
 * A forced rescue does leave the earlier shot files in the gallery. Only the
 * master is de-duplicated (`download_export` drops its own previous copy). For
 * a one-off migration that is the right trade: an extra file the user can
 * delete beats a delete path that could take the wrong one.
 */
export async function bringFilmHome(
  slug: string,
  { force = false }: { force?: boolean } = {},
): Promise<BringFilmHomeResult> {
  const existing = broughtHomeNoteId(slug);
  if (existing && !force) {
    return { noteId: existing, alreadyHome: true, artifactCount: 0, problems: [] };
  }

  const film = await videomakerBringHome(slug);

  for (const piece of film.pieces) {
    registerDownloadedArtifact(
      { path: piece.path, fileName: piece.fileName, bytes: piece.bytes },
      {
        kind: artifactKind(piece),
        model: "videomaker",
        prompt: piece.prompt?.trim() ?? heading(piece),
      },
    );
  }

  const { title, markdown } = composeFilmNote(film);
  const noteId = existing ?? (await createNote()).id;
  await updateNote({ noteId, title, editedContent: markdown });
  rememberBroughtHome(slug, noteId);

  return {
    noteId,
    alreadyHome: false,
    artifactCount: film.pieces.length,
    problems: film.problems,
  };
}
