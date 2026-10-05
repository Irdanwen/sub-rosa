/**
 * A script reading, landed in a film project.
 *
 * The reader returns the prompt bible's camera, line and sound as flat
 * vocabulary ids (`src-tauri/src/shotlist`, ADR-0074). This is where they
 * become a shot's `framing` and `move`, where a reading made before the
 * vocabulary still lands, and where a shot keeps following the bible as it
 * fills in: an imported shot that nobody has rendered yet moves to the
 * reference models as soon as somebody it shows has a picture.
 */

import { t } from "../i18n";
import { BIBLE_KINDS, type BibleKind } from "./bible/types";
import type { CameraMove, ShotFraming } from "./direction/types";
import { known } from "./direction/vocabulary";
import { newShot, type ProjectDocument, type ProjectShot } from "./projects";
import type { MediaCatalog } from "./types";
import { routeModels, type Shot, shotReferences } from "./workflow/compile";

export interface ReadingCastMember {
  name: string;
  kind: BibleKind;
  traits: string;
}

/** The film's genre, moods and pacing as the reader proposes them. */
export interface ProposedDirection {
  genre?: string;
  moods?: string[];
  pacing?: string;
}

export interface LandedReading {
  shots: ProjectShot[];
  cast: ReadingCastMember[];
  language?: string;
  direction?: ProposedDirection;
}

type Raw = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Ids out of the free camera note of a reading made before the vocabulary,
 * by the words a person would use. What matches nothing stays as the note.
 */
const CAMERA_WORDS: ReadonlyArray<[RegExp, keyof ShotFraming | "move", string]> = [
  [/extreme close|very close|tr[eè]s gros plan/i, "size", "extreme-close-up"],
  [/medium close|plan rapproch/i, "size", "medium-close-up"],
  [/close[- ]?up|gros plan/i, "size", "close-up"],
  [/extreme wide|establishing|plan d'ensemble/i, "size", "extreme-wide"],
  [/medium shot|plan taille|mid shot/i, "size", "medium"],
  [/wide|plan large/i, "size", "wide"],
  [/over[- ]the[- ]shoulder/i, "size", "over-the-shoulder"],
  [/two[- ]shot/i, "size", "two-shot"],
  [/\bpov\b|point of view/i, "size", "pov"],
  [/insert|macro/i, "size", "insert"],
  [/low angle|contre-plong/i, "angle", "low"],
  [/high angle|plong[ée]e/i, "angle", "high"],
  [/overhead|top[- ]down|z[ée]nith/i, "angle", "overhead"],
  [/dutch/i, "angle", "dutch"],
  [/push(?:es)?[- ]?in|dolly in|travelling avant|move in/i, "move", "push-in"],
  [/pull(?:s)?[- ]?(?:out|back)|dolly out|travelling arri/i, "move", "pull-out"],
  [/pan(?:s)? left/i, "move", "pan-left"],
  [/pan(?:s)? right|\bpan\b/i, "move", "pan-right"],
  [/tilt(?:s)? up/i, "move", "tilt-up"],
  [/tilt(?:s)? down/i, "move", "tilt-down"],
  [/handheld|cam[ée]ra [ée]paule/i, "move", "handheld"],
  [/tracking|travelling lat/i, "move", "lateral"],
  [/follow/i, "move", "follow"],
  [/orbit|circl/i, "move", "orbit"],
  [/crane|rising|grue/i, "move", "crane"],
  [/drone|aerial/i, "move", "drone"],
  [/static|locked|fixe/i, "move", "static"],
];

export function cameraFromWords(camera: string): { framing?: ShotFraming; move?: CameraMove } {
  const framing: ShotFraming = {};
  let move: CameraMove | undefined;
  for (const [pattern, field, id] of CAMERA_WORDS) {
    if (!pattern.test(camera)) continue;
    if (field === "move") move ??= { kind: id, ...(/slow/i.test(camera) ? { speed: "slow" } : {}) };
    else framing[field] ??= id;
  }
  return {
    ...(Object.keys(framing).length ? { framing } : {}),
    ...(move ? { move } : {}),
  };
}

function shotFrom(raw: Raw, index: number): ProjectShot {
  const framing: ShotFraming = {};
  const size = known("shotSizes", raw.size);
  const lens = known("lenses", raw.lens);
  const depth = known("depths", raw.depth);
  const angle = known("angles", raw.angle);
  if (size) framing.size = size;
  if (lens) framing.lens = lens;
  if (depth) framing.depth = depth;
  if (angle) framing.angle = angle;
  const kind = known("movements", raw.movement);
  const amplitude = known("amplitudes", raw.amplitude);
  const speed = known("speeds", raw.speed);
  const camera = text(raw.camera);
  const fromWords = Object.keys(framing).length || kind ? {} : cameraFromWords(camera);
  const continues = raw.continues === true;
  const scene = text(raw.scene);
  const tone = known("tones", raw.tone);
  const pace = known("paces", raw.pace);
  const transition = known("transitions", raw.transition);
  const effects = text(raw.effects).trim();
  return {
    ...newShot(index),
    scene,
    action: text(raw.action),
    camera,
    characters: Array.isArray(raw.characters) ? raw.characters.map(text).filter(Boolean) : [],
    location: text(raw.location),
    dialogue: text(raw.dialogue),
    speaker: text(raw.speaker),
    motion: text(raw.motion) || "medium",
    continues,
    title: scene || t("Shot {number}", { number: index + 1 }),
    mode: continues ? "continuation" : "text",
    modeSource: "import",
    ...(Object.keys(framing).length ? { framing } : {}),
    ...(kind
      ? { move: { kind, ...(amplitude ? { amplitude } : {}), ...(speed ? { speed } : {}) } }
      : {}),
    ...fromWords,
    ...(transition ? { transition } : {}),
    ...(tone ? { tone } : {}),
    ...(pace ? { pace } : {}),
    ...(raw.voiceover === true ? { voiceover: true } : {}),
    ...(effects ? { effects } : {}),
  };
}

/** A stored reading, old shape or new, as shots and a cast. */
export function landReading(json: string): LandedReading {
  const parsed: unknown = JSON.parse(json);
  const body =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Raw) : undefined;
  const rawShots = Array.isArray(parsed) ? parsed : Array.isArray(body?.shots) ? body.shots : [];
  const shots = rawShots
    .filter((shot): shot is Raw => Boolean(shot) && typeof shot === "object")
    .map(shotFrom);
  const cast = Array.isArray(body?.cast)
    ? body.cast.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const member = entry as Raw;
        const name = text(member.name).trim();
        if (!name || !BIBLE_KINDS.includes(member.kind as BibleKind)) return [];
        return [{ name, kind: member.kind as BibleKind, traits: text(member.traits) }];
      })
    : [];
  const language = text(body?.language).trim().toLowerCase() || undefined;
  const raw =
    body?.direction && typeof body.direction === "object" ? (body.direction as Raw) : undefined;
  const genre = known("genres", raw?.genre);
  const pacing = known("pacings", raw?.pacing);
  const moods = Array.isArray(raw?.moods)
    ? raw.moods.flatMap((mood) => known("moods", mood) ?? []).slice(0, 2)
    : [];
  const direction =
    genre || pacing || moods.length
      ? {
          ...(genre ? { genre } : {}),
          ...(moods.length ? { moods } : {}),
          ...(pacing ? { pacing } : {}),
        }
      : undefined;
  return { shots, cast, language, direction };
}

/**
 * Imported shots nobody has rendered yet follow the bible: references once
 * somebody they show has a picture and the project can render from
 * references, text otherwise. A mode a person chose is never touched.
 */
export function rerouteImportedShots(
  document: ProjectDocument,
  catalog: MediaCatalog,
): ProjectDocument {
  const reference = routeModels(catalog, document.settings.videoModelId || undefined).reference;
  let changed = false;
  const shots = document.shots.map((shot) => {
    if (shot.modeSource !== "import" || shot.takeIds.length > 0 || shot.continues) return shot;
    if (shot.mode !== "text" && shot.mode !== "reference") return shot;
    const wanted =
      reference && shotReferences(shot as Shot, document.bible).length > 0 ? "reference" : "text";
    if (wanted === shot.mode) return shot;
    changed = true;
    return { ...shot, mode: wanted } satisfies ProjectShot;
  });
  return changed ? { ...document, shots } : document;
}
