// A composition: one source image, several new ones. A pack names the images
// to make; each shot is its own instruction to an edit model, written against
// the source as "image 1", with the identity held by the same sentence the
// project bible uses when it draws a sheet from a photo
// (`compileBibleReference` in project-production.ts).
//
// A nine-shot pack can also be drawn as one 3 by 3 sheet and cut into nine
// images: one paid edit instead of nine, at a ninth of the resolution each.

import { t } from "../../i18n";

export interface ComposeShot {
  /** What the person reads on the result. */
  label: string;
  /** What the model is asked for, after the identity sentence. */
  instruction: string;
  /** A ratio for this shot alone, when the pack is about formats. */
  aspectRatio?: string;
}

export interface ComposePack {
  id: string;
  label: string;
  description: string;
  shots: ComposeShot[];
}

/** The model is asked to keep who or what is in the source before anything
 * else, or a new angle comes back as a new person. */
export const IDENTITY_LOCK =
  "Keep the subject of image 1 exactly: the same face, hair, build and outfit for a person, the same shape, colours, materials and markings for an object.";

const REFRAME =
  "Recompose the same image for this frame: extend the background naturally, keep the subject whole and well placed.";

/** How many images one sheet holds, in reading order. */
export const SHEET_CELLS = 9;

export function composePacks(): ComposePack[] {
  return [
    {
      id: "angles",
      label: t("Angles"),
      description: t("The same subject seen from four sides."),
      shots: [
        {
          label: t("Front"),
          instruction: "Show it from the front, at eye level, centred, on the same background.",
        },
        {
          label: t("Three-quarter"),
          instruction: "Show it in three-quarter view from the left, at eye level.",
        },
        {
          label: t("Profile"),
          instruction: "Show it in strict profile from the right side.",
        },
        {
          label: t("From behind"),
          instruction: "Show it from behind, the same framing as the front view.",
        },
      ],
    },
    {
      id: "character",
      label: t("Character sheet"),
      description: t("Nine views of one person: body, face, expressions."),
      shots: [
        { label: t("Full body, front"), instruction: "Full body from the front, neutral pose." },
        { label: t("Full body, three-quarter"), instruction: "Full body in three-quarter view." },
        { label: t("Full body, back"), instruction: "Full body from the back." },
        {
          label: t("Portrait"),
          instruction: "Head and shoulders from the front, neutral expression.",
        },
        {
          label: t("Portrait, three-quarter"),
          instruction: "Head and shoulders in three-quarter view.",
        },
        { label: t("Profile"), instruction: "Head and shoulders in profile." },
        { label: t("Smiling"), instruction: "Close-up of the face, smiling." },
        { label: t("Surprised"), instruction: "Close-up of the face, surprised." },
        { label: t("Tense"), instruction: "Close-up of the face, tense." },
      ],
    },
    {
      id: "expressions",
      label: t("Expressions"),
      description: t("Nine close-ups of the same face."),
      shots: [
        { label: t("Joyful"), instruction: "Close-up of the face, laughing with joy." },
        { label: t("Calm"), instruction: "Close-up of the face, calm and relaxed." },
        { label: t("Thoughtful"), instruction: "Close-up of the face, thoughtful, looking aside." },
        { label: t("Surprised"), instruction: "Close-up of the face, surprised." },
        { label: t("Sad"), instruction: "Close-up of the face, sad, eyes lowered." },
        { label: t("Angry"), instruction: "Close-up of the face, angry." },
        {
          label: t("Doubtful"),
          instruction: "Close-up of the face, doubtful, one eyebrow raised.",
        },
        { label: t("Tired"), instruction: "Close-up of the face, tired." },
        {
          label: t("Determined"),
          instruction: "Close-up of the face, determined, looking at the camera.",
        },
      ],
    },
    {
      id: "scenes",
      label: t("Scenes"),
      description: t("The same subject in four places."),
      shots: [
        {
          label: t("City street"),
          instruction: "Place it in a busy city street in daylight, photographed naturally.",
        },
        {
          label: t("Nature"),
          instruction: "Place it outdoors in green nature, soft afternoon light.",
        },
        {
          label: t("Interior"),
          instruction: "Place it in a warm, lived-in interior with window light.",
        },
        {
          label: t("Studio"),
          instruction: "Place it in a clean photo studio on a seamless coloured backdrop.",
        },
      ],
    },
    {
      id: "light",
      label: t("Light and seasons"),
      description: t("The same scene at four moments."),
      shots: [
        {
          label: t("Golden hour"),
          instruction: "Keep the scene and relight it at golden hour, low warm sun.",
        },
        {
          label: t("Night"),
          instruction: "Keep the scene and make it night, with practical lights.",
        },
        {
          label: t("Winter"),
          instruction: "Keep the scene and make it winter, with snow and cold light.",
        },
        {
          label: t("Rain"),
          instruction: "Keep the scene and make it rain, wet surfaces and reflections.",
        },
      ],
    },
    {
      id: "formats",
      label: t("Formats"),
      description: t("The same image reframed for each screen."),
      shots: [
        { label: t("Square"), aspectRatio: "1:1", instruction: REFRAME },
        { label: t("Vertical story"), aspectRatio: "9:16", instruction: REFRAME },
        { label: t("Landscape"), aspectRatio: "16:9", instruction: REFRAME },
        { label: t("Portrait format"), aspectRatio: "4:5", instruction: REFRAME },
      ],
    },
  ];
}

/** The free pack: one shot per line the person wrote. */
export function customPack(lines: string): ComposePack {
  const shots = lines
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, SHEET_CELLS)
    .map((line) => ({ label: line, instruction: line }));
  return {
    id: "custom",
    label: t("Your own list"),
    description: t("One image per line."),
    shots,
  };
}

/** The instruction for one shot, made separately. */
export function shotPrompt(shot: ComposeShot): string {
  return `${IDENTITY_LOCK} ${shot.instruction}`;
}

/** Whether a pack can be drawn as one sheet and cut. */
export function sheetable(pack: ComposePack): boolean {
  return pack.shots.length === SHEET_CELLS && pack.shots.every((shot) => !shot.aspectRatio);
}

/** The instruction for a whole nine-shot pack drawn as one grid. The layout is
 * fixed because the app cuts it by position (`cutSheetCells`). */
export function sheetPrompt(pack: ComposePack): string {
  const panels = pack.shots.map((shot, index) => `${index + 1}. ${shot.instruction}`).join(" ");
  return `${IDENTITY_LOCK} Draw one square image divided into a three by three grid of nine equal panels with thin even gutters, on one plain light grey background, the same subject in every panel. Panels in reading order, left to right then top to bottom: ${panels} Consistent lighting in every panel, no labels, no numbers.`;
}
