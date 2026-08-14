/**
 * What a video model actually accepts, when the catalog will not say.
 *
 * 43 of the 101 video models the operator lists carry no constraints at all:
 * the enrichment pass matches them against Venice's public catalog, which does
 * not publish those families. The studio only draws a picker for values it
 * knows, so a model with no published `aspect_ratios` got no picker, sent no
 * `aspect_ratio`, and the provider rejected the render.
 *
 * Three sources, most trustworthy first:
 *
 *  1. **Learned** - the provider's own rejection message enumerates what it
 *     wanted ("Expected '21:9' | '16:9' | ..."). Parsing that is the only
 *     source that stays correct when a provider changes its mind, so it wins.
 *  2. **Published** - the merged catalog, when it has anything to say.
 *  3. **Probed** - the table below, measured against the live API on
 *     2026-08-02 by sending deliberately invalid requests (a rejected request
 *     never renders, so this cost nothing to establish).
 *
 * Why probing was needed at all: `/video/quote` accepts payloads that
 * `/video/queue` will not, and the queue itself accepts anything - the real
 * validation happens upstream and only surfaces on retrieve. So there is no
 * free way to ask "is this request valid" before spending; the client has to
 * know.
 *
 * Fields that do NOT exist on these video models, probed the same way and
 * rejected as unrecognised keys: `seed` and `camera_fixed`. Seeds are an image
 * concept here (see `ImageStudio`); there is no picker to add for video, and
 * sending one fails the render outright.
 */

import type { MediaModel, VideoConstraints } from "./types";

const LEARNED_STORAGE_KEY = "os-june:studio-model-constraints";

export interface ProbedConstraints {
  /** Matched against the model id, most specific entry first. */
  match: string;
  durations?: string[];
  aspectRatios?: string[];
  resolutions?: string[];
}

function secondsRange(min: number, max: number): string[] {
  return Array.from({ length: max - min + 1 }, (_, index) => `${min + index}s`);
}

/** The aspect ratios every model that takes one offers (read off the
 * provider's own rejection). */
const SEEDANCE_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

/** The reference variants also take "adaptive", which is what the edit, extend
 * and stitch workflows want: the output keeps the source clip's shape rather
 * than being reframed (Venice's Seedance guide uses it in every such example).
 * Last on purpose — the first entry is what an unset field falls back to, and
 * a plain reference render should keep its explicit shape. */
const SEEDANCE_REFERENCE_RATIOS = [...SEEDANCE_RATIOS, "adaptive"];

/**
 * Image-to-video models take their frame from the source image, so
 * `aspect_ratio` is not a parameter there at all - the validator answers
 * "This model does not support aspect_ratio" rather than listing values, and
 * the catalogs express the same thing by publishing an empty list. Offering a
 * control for it would be inventing a setting.
 */
function takesAspectRatio(modelId: string): boolean {
  return !modelId.toLowerCase().includes("image-to-video");
}

/**
 * Probed capabilities, most specific match first. Only ever consulted for a
 * field the catalog left empty, so a family that starts publishing its
 * constraints silently takes over.
 *
 * Resolutions vary per model rather than per family, which is easy to get
 * wrong: 2.0 reaches 4k, 2.0 fast stops at 720p, and 1.5 pro at 1080p.
 * Durations are every whole second in range, not just the round ones.
 */
export const PROBED_VIDEO_CONSTRAINTS: ProbedConstraints[] = [
  {
    match: "seedance-1-5-pro",
    durations: secondsRange(4, 12),
    aspectRatios: SEEDANCE_RATIOS,
    resolutions: ["480p", "720p", "1080p"],
  },
  {
    // 2.5 doubles the output range and drops 1080p/4k (Venice's Seedance
    // guide, read 2026-08-14). Ahead of the generic seedance entry, which
    // would otherwise cap it at 15s.
    match: "seedance-2-5",
    durations: secondsRange(4, 30),
    aspectRatios: SEEDANCE_RATIOS,
    resolutions: ["480p", "720p"],
  },
  {
    match: "seedance-2-0-fast",
    durations: secondsRange(4, 15),
    aspectRatios: SEEDANCE_RATIOS,
    resolutions: ["480p", "720p"],
  },
  {
    match: "seedance",
    durations: secondsRange(4, 15),
    aspectRatios: SEEDANCE_RATIOS,
    resolutions: ["480p", "720p", "1080p", "4k"],
  },
  // The reference variant takes a shorter list than its image counterpart.
  { match: "wan-2-7-reference-to-video", durations: ["5s", "10s"] },
  { match: "wan-2-7", durations: ["5s", "10s", "15s"] },
  { match: "kling-o3", durations: secondsRange(3, 15) },
  { match: "kling-v3-4k", durations: secondsRange(3, 15) },
  { match: "happyhorse", durations: secondsRange(3, 15) },
  { match: "pixverse-c1", durations: ["3s", "5s", "8s", "10s", "15s"] },
  { match: "minimax-h3", durations: secondsRange(5, 15) },
  { match: "longcat", durations: ["5s", "10s", "15s", "20s", "30s"] },
  { match: "vidu-q3", durations: ["3s", "5s", "8s", "10s", "12s", "14s", "16s"] },
];

export function probedConstraints(modelId: string): ProbedConstraints | undefined {
  const id = modelId.toLowerCase();
  const entry = PROBED_VIDEO_CONSTRAINTS.find((probe) => id.includes(probe.match));
  if (!entry) return undefined;
  // The ratios in the table belong to the variants that take one.
  if (!takesAspectRatio(modelId)) return { ...entry, aspectRatios: undefined };
  // Seedance reference variants also take "adaptive" (keep the source clip's
  // shape), which the edit/extend/stitch workflows are written around.
  if (id.includes("seedance") && id.includes("reference-to-video")) {
    return { ...entry, aspectRatios: SEEDANCE_REFERENCE_RATIOS };
  }
  return entry;
}

// --- learning from the provider's own rejection -----------------------------

export interface LearnedConstraints {
  durations?: string[];
  aspectRatios?: string[];
  resolutions?: string[];
  /** Fields the provider said it required. */
  required?: string[];
  /** Keys the model refused outright, so a retry does not resend them. */
  rejectedKeys?: string[];
}

/** Field name in the error to the constraint it describes. */
const FIELD_TO_CONSTRAINT: Record<string, keyof LearnedConstraints> = {
  duration: "durations",
  aspect_ratio: "aspectRatios",
  resolution: "resolutions",
};

/**
 * Read a provider rejection for what it says the model accepts.
 *
 * The message is a Zod report, reachable either raw or escaped inside a JSON
 * string, so both quote styles are matched. It is also truncated by the
 * operator at ~200 characters, which means a second faulty field can be cut
 * off entirely - nothing here may assume the report is complete.
 */
export function parseConstraintError(message: string): LearnedConstraints {
  const learned: LearnedConstraints = {};
  const quote = `\\\\?"`;

  // "field":{"_errors":["Invalid enum value. Expected 'a' | 'b', received 'x'"]}
  const enumPattern = new RegExp(
    `${quote}(\\w+)${quote}:\\{${quote}_errors${quote}:\\[${quote}Invalid enum value\\. Expected ([^\\]]*?), received`,
    "g",
  );
  for (const match of message.matchAll(enumPattern)) {
    const target = FIELD_TO_CONSTRAINT[match[1]];
    if (!target || target === "required") continue;
    const values = [...match[2].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    if (values.length > 0) learned[target] = values;
  }

  // "field":{"_errors":["Required"]}
  const requiredPattern = new RegExp(
    `${quote}(\\w+)${quote}:\\{${quote}_errors${quote}:\\[${quote}Required${quote}\\]`,
    "g",
  );
  const required = [...message.matchAll(requiredPattern)].map((match) => match[1]);
  if (required.length > 0) learned.required = required;

  // A missing field is reported as a type error, and that report carries the
  // enum it wanted: "expected":"'21:9' | '16:9' | ...". Reading it means one
  // rejection is enough to populate the picker, instead of needing a second
  // round-trip with a deliberately wrong value. The accompanying "path" is
  // often truncated mid-word by the operator, so it is matched by prefix.
  const expectedPattern = new RegExp(
    `${quote}expected${quote}:${quote}((?:'[^']+'(?:\\s*\\|\\s*)?)+)${quote}[^}]*?${quote}path${quote}:\\[${quote}([a-z_]+)`,
    "g",
  );
  for (const match of message.matchAll(expectedPattern)) {
    const values = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    if (values.length === 0) continue;
    const prefix = match[2];
    const field = Object.keys(FIELD_TO_CONSTRAINT).find((name) => name.startsWith(prefix));
    const target = field ? FIELD_TO_CONSTRAINT[field] : undefined;
    if (!target || target === "required" || target === "rejectedKeys" || learned[target]) continue;
    learned[target] = values;
  }

  // The structured shape the operator is moving to, where the validator's own
  // rows travel as `details.issues` instead of a wrapped string. It is real
  // JSON, so it is read as JSON rather than pattern-matched.
  for (const issue of structuredIssues(message)) {
    const field = typeof issue.param === "string" ? issue.param : issue.path;
    if (typeof field !== "string") continue;
    if (issue.code === "unrecognized_keys" || /unrecognized/i.test(String(issue.message ?? ""))) {
      learned.rejectedKeys = [...new Set([...(learned.rejectedKeys ?? []), field])];
      continue;
    }
    const target = FIELD_TO_CONSTRAINT[field];
    if (!target || target === "required" || target === "rejectedKeys") continue;
    const values = issue.accepted ?? issue.expected;
    if (Array.isArray(values)) {
      const strings = values.filter((entry): entry is string => typeof entry === "string");
      if (strings.length > 0 && !learned[target]) learned[target] = strings;
    }
  }

  return learned;
}

/**
 * Fields the model demands that the request does not carry. Empty when nothing
 * has been learned about the model yet - this only ever reports what a
 * provider explicitly complained about, never a guess.
 */
export function missingRequiredFields(modelId: string, body: Record<string, unknown>): string[] {
  const required = learnedConstraints(modelId)?.required ?? [];
  return required.filter((field) => body[field] === undefined || body[field] === "");
}

interface StructuredIssue {
  param?: unknown;
  path?: unknown;
  code?: unknown;
  message?: unknown;
  accepted?: unknown;
  expected?: unknown;
  keys?: unknown;
}

/**
 * The `details.issues` rows of a structured rejection, or nothing when the
 * message is not one (an older wrapped string, a network error, plain text).
 * A body that does not parse is not an error here - the regex readers above
 * still get their turn.
 */
function structuredIssues(message: string): StructuredIssue[] {
  const start = message.indexOf("{");
  if (start < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.slice(start));
  } catch {
    return [];
  }
  const details = (parsed as { details?: { issues?: unknown } })?.details;
  const issues = details?.issues;
  if (!Array.isArray(issues)) return [];
  const rows: StructuredIssue[] = [];
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    const row = issue as StructuredIssue;
    // `unrecognized_keys` carries its subject in `keys[]` rather than a field.
    if (Array.isArray(row.keys)) {
      for (const key of row.keys) {
        if (typeof key === "string") rows.push({ path: key, code: "unrecognized_keys" });
      }
      continue;
    }
    rows.push(row);
  }
  return rows;
}

function readLearned(): Record<string, LearnedConstraints> {
  try {
    const raw = window.localStorage.getItem(LEARNED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, LearnedConstraints>)
      : {};
  } catch {
    return {};
  }
}

export function learnedConstraints(modelId: string): LearnedConstraints | undefined {
  return readLearned()[modelId];
}

/**
 * Remember what a rejection taught us about this model. Returns what was
 * learned (empty when the message carried nothing usable), so the caller can
 * refresh its pickers only when something actually changed.
 */
export function rememberConstraintError(modelId: string, message: string): LearnedConstraints {
  const learned = parseConstraintError(message);
  if (Object.keys(learned).length === 0) return {};
  try {
    const all = readLearned();
    all[modelId] = { ...all[modelId], ...learned };
    window.localStorage.setItem(LEARNED_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Learning is an optimisation: without it the next attempt is simply as
    // uninformed as this one was.
  }
  return learned;
}

/** Test seam. */
export function forgetLearnedConstraints() {
  try {
    window.localStorage.removeItem(LEARNED_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

// --- the three sources, merged ----------------------------------------------

/**
 * What the studio should offer for this model: learned over published over
 * probed, field by field. A field nobody knows anything about stays empty, and
 * the studio then sends nothing for it - which is right, because an unknown
 * key is rejected just as hard as a missing required one.
 */
export function effectiveVideoConstraints(model: MediaModel | undefined): VideoConstraints {
  if (!model) return {};
  const published = model.constraints ?? {};
  const probed = probedConstraints(model.id);
  const learned = learnedConstraints(model.id);
  const pick = (
    fromLearned: string[] | undefined,
    fromPublished: string[] | undefined,
    fromProbed: string[] | undefined,
  ): string[] | undefined => {
    if (fromLearned?.length) return fromLearned;
    // A published empty list is a statement, not a gap: the model does not
    // take that field, so nothing may fill it in.
    if (fromPublished !== undefined) return fromPublished.length ? fromPublished : undefined;
    return fromProbed?.length ? fromProbed : undefined;
  };
  return {
    ...published,
    durations: pick(learned?.durations, published.durations, probed?.durations),
    aspect_ratios: pick(learned?.aspectRatios, published.aspect_ratios, probed?.aspectRatios),
    resolutions: pick(learned?.resolutions, published.resolutions, probed?.resolutions),
  };
}

// --- making a rejection readable --------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  aspect_ratio: "an aspect ratio",
  duration: "a duration",
  resolution: "a resolution",
};

/**
 * A rejection in one sentence, or undefined when the message is not one of
 * these schema reports (the caller then shows it as-is rather than hiding it).
 */
export function explainConstraintError(message: string): string | undefined {
  const learned = parseConstraintError(message);
  const parts: string[] = [];
  for (const field of learned.required ?? []) {
    parts.push(`needs ${FIELD_LABELS[field] ?? field.replace(/_/g, " ")}`);
  }
  const offered: Array<[keyof LearnedConstraints, string]> = [
    ["aspectRatios", "aspect ratio"],
    ["durations", "duration"],
    ["resolutions", "resolution"],
  ];
  for (const [key, label] of offered) {
    const values = learned[key];
    if (Array.isArray(values) && values.length > 0) {
      parts.push(`takes ${label} ${values.join(", ")}`);
    }
  }
  if (parts.length === 0) return undefined;
  return `This model ${parts.join(" and ")}. The options have been updated - try again.`;
}
