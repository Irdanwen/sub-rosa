/**
 * The one place a project shot's video prompt is written (ADR-0074).
 *
 * The prompt bible's template, block by block: [OVERALL] genre, mood,
 * duration and pacing; [REFERENCES] each image with its role; [SUBJECT] the
 * frozen descriptors; [SHOT] size, lens, angle, one movement with its
 * amplitude and speed, then the action as physical events; [DIALOGUE];
 * [SOUND]; [STYLE]; [NEGATIVE]. The blocks are data first and text last, so
 * every family gets the same content written its own way (`profiles.ts`):
 * labelled or in prose, with or without a time range, a line spoken in the
 * family's syntax or laid in afterwards.
 *
 * Three rules from the bible are code here rather than advice:
 *
 * - **Never lose the subject or the camera.** Over budget, the sound goes
 *   first, then secondary references, optional negatives, lens details and
 *   the mood. Subject, framing, movement, action and a spoken line stay; a
 *   prompt over budget is reported, never silently gutted.
 * - **[STYLE] and the film's genre and mood are identical on every shot.**
 *   Their wording depends on the film and the family, never on one shot's
 *   budget pressure (`lockedStyle`, `lockedTone`).
 * - **A seedance reference prompt opens with "Refer to".** That opening is
 *   what routes the request (`seedance.ts`), so the references open it.
 */

import type { StackedReference } from "../bible/prompt";
import type { BibleEntry } from "../bible/types";
import { entry, write } from "../direction/vocabulary";
import type { DialogueMode, FilmDirection } from "../direction/types";
import { MAX_MOODS } from "../direction/types";
import type { MediaModel } from "../types";
import type { Shot } from "../workflow/compile";
import { negativeLines } from "./negative";
import { canSilence, type FamilyProfile, familyProfile, rendersAudio } from "./profiles";
import { referenceBlock } from "./references";
import { referenceMention } from "../seedance";
import { fullDescriptor, guessLanguage, languageName, shortDescriptor, stateLine } from "./subject";

export type ShotMode = "text" | "image" | "reference" | "continuation";

export type BlockId =
  | "opening"
  | "overall"
  | "references"
  | "subject"
  | "shot"
  | "dialogue"
  | "sound"
  | "style"
  | "negative";

/**
 * How much a part is worth keeping, cheapest first. 0 is never dropped.
 * 1 sound; 2 the scene name and the place's long descriptor (shortened: its
 * image or the frame shows it); 3 secondary characters' long descriptors
 * (shortened); 4 optional negatives; 5 lens details; 6 mood and pacing.
 * A reference's role sentence is never dropped: the image rides either way,
 * and an image with no role is the first cause of drift.
 */
type Tier = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface Part {
  text: string;
  tier: Tier;
  /** What it becomes when its tier goes: a shorter form, or nothing. */
  fallback?: string;
}

export interface PromptBlock {
  id: BlockId;
  /** The bible's label, `[SHOT 1 | 0-5s]` included. */
  label: string;
  parts: Part[];
}

export interface DialoguePlan {
  /** `none`: no line on this shot. */
  mode: "none" | "native" | "dubbed";
  language: string;
  /** Why a line asked to be native is dubbed instead, for a note. */
  downgraded?: boolean;
}

export interface ComposeInput {
  shot: Shot;
  direction?: FilmDirection;
  bible: readonly BibleEntry[];
  model: (Pick<MediaModel, "id"> & Partial<Pick<MediaModel, "constraints">>) | undefined;
  mode: ShotMode;
  /** The seconds the app resolved for this shot. The model never picks one. */
  seconds: number;
  /** The references the request carries, in the order sent. */
  references?: readonly StackedReference[];
  /** A voice the request carries for the speaker, as `<Audio 1>`. */
  voice?: { name: string };
}

export interface ComposedPrompt {
  text: string;
  words: number;
  budget: number;
  /** Words past the family's budget once everything droppable has gone. */
  overBy: number;
  /** What the budget forced out, in the order it went. */
  dropped: string[];
  blocks: PromptBlock[];
  dialogue: DialoguePlan;
  /** Send `audio: false`: the line is laid in later and the model can be quiet. */
  silenceAudio: boolean;
  /** The model cannot be quiet: the montage mutes its clip instead. */
  muteInMontage: boolean;
  profile: FamilyProfile;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return /[.!?"]$/.test(trimmed) ? capitalize(trimmed) : `${capitalize(trimmed)}.`;
}

function joinClauses(parts: readonly string[]): string {
  return parts.filter(Boolean).join(", ");
}

function byName(bible: readonly BibleEntry[], name: string): BibleEntry | undefined {
  const wanted = name.trim().toLowerCase();
  return wanted
    ? bible.find((candidate) => candidate.name.trim().toLowerCase() === wanted)
    : undefined;
}

/**
 * Whether this shot's line is spoken by the video model.
 *
 * Native only when the model renders sound *and* speaks the line's language
 * (H3 speaks French; the others English at most). Anything unsure is dubbed:
 * a dubbed line costs a voice, a native line in a language the model does
 * not speak costs a take.
 */
export function resolveDialogue(
  shot: Pick<Shot, "dialogue" | "dialogueMode">,
  direction: FilmDirection | undefined,
  model: ComposeInput["model"],
): DialoguePlan {
  const line = shot.dialogue.trim();
  const language = direction?.dialogueLanguage || (line ? guessLanguage(line) : "en");
  if (!line) return { mode: "none", language };
  const wanted: DialogueMode = shot.dialogueMode ?? "auto";
  if (wanted === "dubbed") return { mode: "dubbed", language };
  const profile = familyProfile(model);
  const speaks = rendersAudio(model) && profile.dialogueLangs.includes(language);
  if (speaks) return { mode: "native", language };
  return { mode: "dubbed", language, downgraded: wanted === "native" };
}

/** Light as the bible writes it: source with its direction, then quality and the rest. */
function lightWords(direction: FilmDirection | undefined, full: boolean): string {
  const light = direction?.light;
  if (!light) return "";
  const source = write("lightSources", light.source);
  const from = write("lightDirections", light.direction);
  const parts = [
    source && from ? `${source} ${from}` : source || from,
    write("lightQualities", light.quality),
  ];
  if (full) {
    parts.push(
      write("lightMoments", light.moment),
      write("lightContrasts", light.contrast),
      ...(light.effects ?? []).map((effect) => write("lightEffects", effect)),
    );
  }
  return joinClauses(parts);
}

/**
 * The film's [STYLE], in the wording this family gets on every shot.
 * Tight families keep the look and the palette; the rest add the light, then
 * the texture. Never trimmed per shot: the bible's coherence rule.
 */
export function lockedStyle(direction: FilmDirection | undefined, profile: FamilyProfile): string {
  if (!direction) return "";
  const budget = profile.budgetWords;
  const parts = [write("looks", direction.look), write("palettes", direction.palette)];
  if (budget > 60) parts.push(lightWords(direction, budget > 100));
  if (budget > 100) parts.push(write("textures", direction.texture));
  return sentence(joinClauses(parts));
}

/**
 * The film's look for a bible reference: the film look, the palette and the
 * texture, never the light, which a reference keeps even.
 */
export function referenceStyle(direction: FilmDirection | undefined): string {
  if (!direction) return "";
  return joinClauses([
    write("looks", direction.look),
    write("palettes", direction.palette),
    write("textures", direction.texture),
  ]);
}

/** The film's whole [STYLE], for an image model that has no word budget to keep. */
export function fullStyle(direction: FilmDirection | undefined): string {
  return lockedStyle(direction, { ...familyProfile(undefined), budgetWords: 1000 });
}

/** A shot's frame in the bible's words, for the image that opens it. */
export function framingWords(shot: Shot, direction: FilmDirection | undefined): string {
  const framing = { ...direction?.shotDefaults?.framing, ...shot.framing };
  return sentence(
    joinClauses([
      write("shotSizes", framing.size),
      write("lenses", framing.lens),
      write("depths", framing.depth),
      write("angles", framing.angle),
    ]),
  );
}

/** The film's genre and moods, as every shot of it opens. */
export function lockedTone(direction: FilmDirection | undefined, profile: FamilyProfile): string {
  if (!direction) return "";
  const genre = write("genres", direction.genre);
  const moods = (direction.moods ?? [])
    .slice(0, profile.budgetWords <= 60 ? 1 : MAX_MOODS)
    .map((mood) => write("moods", mood))
    .filter(Boolean);
  if (!genre && moods.length === 0) return "";
  // One mood keeps its pair of words; two keep the first of each, the
  // bible's "melancholic and tender" rather than four adjectives.
  const mood =
    moods.length > 1
      ? moods.map((words) => words.split(",")[0].trim()).join(" and ")
      : (moods[0] ?? "");
  return sentence(joinClauses([genre, mood]));
}

function overallBlock(input: ComposeInput, profile: FamilyProfile): PromptBlock {
  const { direction, seconds } = input;
  const tight = profile.budgetWords <= 60;
  const tone = lockedTone(direction, profile);
  const shift = direction?.moodShift;
  const shiftFrom = write("moods", shift?.from);
  const shiftTo = write("moods", shift?.to);
  const pacing = write("pacings", direction?.pacing);
  const parts: Part[] = [];
  if (tone) {
    const genre = sentence(write("genres", direction?.genre));
    parts.push({ text: tone, tier: genre ? 6 : 0, fallback: genre });
  }
  if (shiftFrom && shiftTo && !tight)
    parts.push({ text: `The mood shifts from ${shiftFrom} to ${shiftTo}.`, tier: 6 });
  if (!tight) {
    const timing = seconds > 0 ? `${Math.round(seconds)} seconds` : "";
    const text = sentence(joinClauses([timing, pacing]));
    if (text) parts.push({ text, tier: pacing ? 6 : 0, fallback: sentence(timing) });
    parts.push({ text: "Single continuous shot.", tier: 0 });
  }
  if (direction?.era?.trim())
    parts.push({ text: sentence(`Set in ${direction.era.trim()}`), tier: 0 });
  return { id: "overall", label: "[OVERALL]", parts };
}

function subjectBlock(input: ComposeInput, profile: FamilyProfile): PromptBlock {
  const { shot, bible, mode } = input;
  const tight = profile.budgetWords <= 100;
  // The image already shows the look; references carry it on a tight budget.
  const short = mode === "image" || mode === "continuation" || (mode === "reference" && tight);
  const characters = shot.characters
    .map((name) => byName(bible, name))
    .filter((candidate): candidate is BibleEntry => candidate !== undefined);
  const location = byName(bible, shot.location);
  const parts: Part[] = [];
  characters.forEach((character, index) => {
    const full = fullDescriptor(character);
    const brief = shortDescriptor(character);
    if (short) parts.push({ text: brief, tier: 0 });
    else if (index === 0) parts.push({ text: full, tier: 0 });
    else parts.push({ text: full, tier: 3, fallback: brief });
    const state = stateLine(shot.states?.[character.name]);
    if (state) parts.push({ text: state, tier: 0 });
  });
  for (const name of shot.characters) {
    if (!byName(bible, name) && name.trim()) parts.push({ text: sentence(name), tier: 0 });
  }
  if (location) {
    const full = fullDescriptor(location);
    parts.push(
      short
        ? { text: shortDescriptor(location), tier: 0 }
        : { text: full, tier: 2, fallback: shortDescriptor(location) },
    );
  } else if (shot.scene.trim()) {
    parts.push({ text: sentence(shot.scene), tier: 2 });
  }
  return { id: "subject", label: "[SUBJECT]", parts };
}

function shotLabel(seconds: number, profile: FamilyProfile): string {
  if (profile.timecodes === "words" || seconds <= 0) return "[SHOT 1]";
  return `[SHOT 1 | 0-${Math.round(seconds)}s]`;
}

function shotBlock(input: ComposeInput, profile: FamilyProfile): PromptBlock {
  const { shot, direction } = input;
  const framing = { ...direction?.shotDefaults?.framing, ...shot.framing };
  const move = shot.move ?? (shot.framing ? undefined : direction?.shotDefaults?.move);
  const parts: Part[] = [];
  const size = write("shotSizes", framing.size);
  const angle = write("angles", framing.angle);
  const details = joinClauses([write("lenses", framing.lens), write("depths", framing.depth)]);
  if (size || angle || details) {
    // Size and angle hold the frame; the lens and its depth are what a
    // tight budget gives up first.
    const withDetails = sentence(joinClauses([size, details, angle]));
    const without = sentence(joinClauses([size, angle]));
    parts.push(
      details && (size || angle)
        ? { text: withDetails, tier: 5, fallback: without }
        : { text: withDetails, tier: 0 },
    );
  } else if (shot.camera.trim()) {
    parts.push({ text: sentence(shot.camera), tier: 0 });
  }
  const movement = entry("movements", move?.kind);
  if (movement) {
    const range =
      move?.from && move?.to
        ? ` from a ${write("shotSizes", move.from)} to a ${write("shotSizes", move.to)}`
        : "";
    const text = movement.still
      ? movement.write
      : joinClauses([
          `${movement.write}${range}`,
          write("amplitudes", move?.amplitude),
          write("speeds", move?.speed),
        ]);
    parts.push({ text: sentence(text), tier: 0 });
  } else if ((size || angle) && shot.camera.trim()) {
    // A structured frame with no structured move: the free camera note
    // still says how the camera behaves.
    parts.push({ text: sentence(shot.camera), tier: 5 });
  }
  if (shot.action.trim()) parts.push({ text: sentence(shot.action), tier: 0 });
  return { id: "shot", label: shotLabel(input.seconds, profile), parts };
}

function speakerIndex(shot: Shot): number {
  const index = shot.characters.findIndex(
    (name) => name.trim().toLowerCase() === shot.speaker.trim().toLowerCase(),
  );
  return index >= 0 ? index + 1 : 1;
}

/** A line in the family's own syntax. The tone rides on the speaker, never on single words. */
function nativeLine(shot: Shot, profile: FamilyProfile, language: string): string {
  const line = shot.dialogue.trim().replace(/"/g, "'");
  const speaker = shot.speaker.trim() || "The character";
  const tone = write("tones", shot.tone);
  const pace = write("paces", shot.pace);
  const manner = joinClauses([tone, pace]);
  if (shot.voiceover) {
    return `Voiceover (${joinClauses([speaker, manner])}): "${line}" The on-screen character's lips remain closed.`;
  }
  switch (profile.dialogueSyntax) {
    case "h3":
      return `${joinClauses([speaker, manner])} (S${speakerIndex(shot)}), says: [${languageName(language)}] ${line} ${speaker}'s lips close.`;
    case "kling":
      return `${speaker}${manner ? ` (${manner})` : ""}: "${line}"`;
    case "seedance":
      return `${speaker}${manner ? ` (${manner})` : ""} says: {${languageName(language)}: "${line}"}`;
    case "wan":
      return `${speaker}${manner ? ` (${manner})` : ""} says: "${line}" Lip sync.`;
    case "veo":
      return `${speaker} says${tone ? `, ${tone}` : ""}: "${line}"`;
    default:
      return `${speaker}${manner ? ` (${manner})` : ""} says: "${line}"`;
  }
}

function dialogueBlock(
  input: ComposeInput,
  profile: FamilyProfile,
  plan: DialoguePlan,
): PromptBlock {
  const { shot } = input;
  let text = "No dialogue.";
  if (plan.mode === "native") text = nativeLine(shot, profile, plan.language);
  else if (plan.mode === "dubbed" && !shot.voiceover) {
    // The voice is laid in afterwards: show the speaking, never the words.
    const tone = write("tones", shot.tone);
    text = sentence(`${shot.speaker.trim() || "The character"} speaks${tone ? `, ${tone}` : ""}`);
  }
  return { id: "dialogue", label: "[DIALOGUE]", parts: [{ text, tier: 0 }] };
}

function soundBlock(input: ComposeInput): PromptBlock {
  const { shot, direction } = input;
  const effects = shot.effects?.trim();
  const ambience = write("ambiences", direction?.ambience);
  const music = entry("music", direction?.music ?? "none");
  const parts: Part[] = [];
  if (effects) parts.push({ text: sentence(`Effects: ${effects}`), tier: 1 });
  if (ambience) parts.push({ text: sentence(`Ambience: ${ambience}`), tier: 1 });
  if (music && !music.silent) parts.push({ text: sentence(`Music: ${music.write}`), tier: 1 });
  else if (effects || ambience) parts.push({ text: "No background music.", tier: 1 });
  return { id: "sound", label: "[SOUND]", parts };
}

function render(blocks: readonly PromptBlock[], profile: FamilyProfile): string {
  const lines = blocks
    .map((block) => {
      const body = block.parts
        .map((part) => part.text)
        .filter(Boolean)
        .join(" ");
      if (!body) return "";
      return profile.labels && block.id !== "opening" ? `${block.label} ${body}` : body;
    })
    .filter(Boolean);
  return profile.labels ? lines.join("\n") : lines.join(" ");
}

/** The prompt a shot is rendered from, to its family's budget. */
export function composeShotPrompt(input: ComposeInput): ComposedPrompt {
  const profile = familyProfile(input.model);
  const dialogue = resolveDialogue(input.shot, input.direction, input.model);
  const audible = rendersAudio(input.model);
  const dubbedLine = dialogue.mode === "dubbed";
  const silenceAudio = audible && dubbedLine && canSilence(input.model);
  const muteInMontage = audible && dubbedLine && !silenceAudio;
  const soundOn = audible && !dubbedLine;
  const characterCount = input.shot.characters.filter((name) => name.trim()).length;

  const references = referenceBlock(input.references ?? [], input.model);
  const opening: Part[] = [];
  if (profile.firstLine) opening.push({ text: profile.firstLine, tier: 0 });
  if (references.opening) opening.push({ text: references.opening, tier: 0 });

  const framing = { ...input.direction?.shotDefaults?.framing, ...input.shot.framing };
  const move =
    input.shot.move ?? (input.shot.framing ? undefined : input.direction?.shotDefaults?.move);
  const negatives = negativeLines({
    direction: input.direction,
    characterCount,
    moveKind: move?.kind,
    shotSize: framing.size,
    lipsClosed:
      audible &&
      (Boolean(input.shot.voiceover && dialogue.mode !== "none") ||
        (dialogue.mode === "none" && characterCount > 0)),
    soundOn,
  });

  const blocks: PromptBlock[] = [
    { id: "opening", label: "", parts: opening },
    overallBlock(input, profile),
    {
      id: "references",
      label: "[REFERENCES]",
      parts: [
        ...references.sentences.map((reference) => ({ text: reference.text, tier: 0 as const })),
        // The bible's audio role: a line the model speaks, in the voice it was given.
        ...(input.voice && dialogue.mode === "native"
          ? [
              {
                text: `${input.voice.name}'s voice timbre references ${referenceMention(input.model, "audio", 1)}.`,
                tier: 0 as const,
              },
            ]
          : []),
      ],
    },
    subjectBlock(input, profile),
    shotBlock(input, profile),
    dialogueBlock(input, profile, dialogue),
    ...(soundOn ? [soundBlock(input)] : []),
    {
      id: "style",
      label: "[STYLE]",
      parts: [{ text: lockedStyle(input.direction, profile), tier: 0 }],
    },
    {
      id: "negative",
      label: "[NEGATIVE]",
      parts: negatives.map((line) => ({ text: line.text, tier: line.essential ? 0 : 4 })),
    },
  ];

  const budget = profile.budgetWords;
  const dropped: string[] = [];
  // Cheapest tier first, and within a tier one part at a time from the end of
  // the prompt, so a prompt nine words over loses one negative, not all.
  for (const tier of [1, 2, 3, 4, 5, 6] as const) {
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      for (let at = block.parts.length - 1; at >= 0; at--) {
        if (wordCount(render(blocks, profile)) <= budget) break;
        const part = block.parts[at];
        if (part.tier !== tier) continue;
        dropped.push(part.text);
        block.parts.splice(
          at,
          1,
          ...(part.fallback ? [{ text: part.fallback, tier: 0 as const }] : []),
        );
      }
    }
  }
  const text = render(blocks, profile);
  const words = wordCount(text);
  return {
    text,
    words,
    budget,
    overBy: Math.max(0, words - budget),
    dropped,
    blocks: blocks.filter((block) => block.parts.some((part) => part.text)),
    dialogue,
    silenceAudio,
    muteInMontage,
    profile,
  };
}
