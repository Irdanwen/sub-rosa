import { intlLocale, number, t, websiteLocale } from "../lib/i18n";
import type { Copy } from "../pages/docs-content";
import benchmarkData from "./benchmarks.json";
import indexData from "./details/index.json";
import familyData from "./families.json";
import snapshotData from "./snapshot.json";

export type Category =
  | "text"
  | "transcription"
  | "image"
  | "edit"
  | "video"
  | "voice"
  | "music"
  | "effects";

export type Privacy = "private" | "anonymized";

export type SnapshotModel = {
  id: string;
  type: string;
  tier: string;
  privacy: Privacy;
  name: string | null;
  context?: number;
  traits?: string[];
  seconds?: [number, number];
  audio?: boolean;
  resolutions?: string[];
  usdPerMillion?: [number, number];
  credits?: number;
  usdPerSecond?: number;
  usdPerMillionCharacters?: number;
  usdPerMinute?: number;
  usdPerAudioSecond?: number;
  usdPerTrack?: number;
  usdPerMinuteOfMusic?: number;
  usdPerUpscale?: number;
};

export type Family = {
  slug: string;
  category: Category;
  name: string;
  /** Only where the English name is a description rather than a product name. */
  nameFr?: string;
  maker: string;
  ids: string[];
  pick: string;
  variants?: { id: string; note: Copy }[];
  summary: Copy;
  needs: string[];
  /** Empty when no page is fit to link from a public site. */
  url: string;
};

export const snapshot = snapshotData as { checkedAt: string; models: SnapshotModel[] };
export const families = familyData as unknown as Family[];

const modelsById = new Map(snapshot.models.map((model) => [model.id, model]));
export const modelById = (id: string) => modelsById.get(id);
export const familyName = (family: Family) => t(family.name, family.nameFr ?? family.name);
export const familyBySlug = (slug: string) => families.find((family) => family.slug === slug);
export const familyOfModel = (id: string) => families.find((family) => family.ids.includes(id));

export const categories: { id: Category; title: Copy; description: Copy }[] = [
  {
    id: "text",
    title: ["Text and chat", "Texte et discussion"],
    description: [
      "The model that answers you in chat, drives the agent and writes your notes.",
      "Le modèle qui vous répond, pilote l’agent et rédige vos notes.",
    ],
  },
  {
    id: "transcription",
    title: ["Transcription", "Transcription"],
    description: [
      "Turns a recording or a dictation into text.",
      "Transforme un enregistrement ou une dictée en texte.",
    ],
  },
  {
    id: "image",
    title: ["Images", "Images"],
    description: [
      "Creates a picture from a description.",
      "Crée une image à partir d’une description.",
    ],
  },
  {
    id: "edit",
    title: ["Edit and retouch", "Retouche"],
    description: [
      "Changes a picture you already have, in whole or in a painted zone.",
      "Modifie une image existante, entièrement ou dans une zone peinte.",
    ],
  },
  {
    id: "video",
    title: ["Video", "Vidéo"],
    description: [
      "Animates a description, a still image or a set of references.",
      "Anime une description, une image fixe ou un jeu de références.",
    ],
  },
  {
    id: "voice",
    title: ["Voice", "Voix"],
    description: ["Reads a text aloud.", "Lit un texte à voix haute."],
  },
  {
    id: "music",
    title: ["Music", "Musique"],
    description: [
      "Composes a song or a score from a description.",
      "Compose une chanson ou une musique à partir d’une description.",
    ],
  },
  {
    id: "effects",
    title: ["Sound effects", "Bruitages"],
    description: [
      "Creates a short sound: a door, rain, footsteps.",
      "Crée un son court : une porte, la pluie, des pas.",
    ],
  },
];

export const categoryTitle = (id: Category): Copy =>
  categories.find((category) => category.id === id)?.title ?? ["", ""];

/** Whether every model in the family keeps no data, none do, or it depends on the variant. */
export function familyPrivacy(family: Family): Privacy | "mixed" {
  const kinds = new Set(family.ids.map((id) => modelById(id)?.privacy).filter(Boolean));
  if (kinds.size === 1) return [...kinds][0] as Privacy;
  return "mixed";
}

/** The badge a family wears: its recommended version's mode, and a word when others differ. */
export function familyPrivacyLabel(family: Family): { kind: Privacy; label: Copy } {
  const kind = modelById(family.pick)?.privacy ?? "anonymized";
  if (familyPrivacy(family) !== "mixed") return { kind, label: privacyLabel(kind) };
  return {
    kind,
    label:
      kind === "private"
        ? ["Private, some versions anonymized", "Privé, certaines versions anonymisées"]
        : ["Anonymized, some versions private", "Anonymisé, certaines versions privées"],
  };
}

export const privacyLabel = (privacy: Privacy | "mixed"): Copy =>
  privacy === "private"
    ? ["Private", "Privé"]
    : privacy === "anonymized"
      ? ["Anonymized", "Anonymisé"]
      : ["Private or anonymized", "Privé ou anonymisé"];

/** One credit is one US cent. */
const credits = (usd: number) => usd * 100;

/** French keeps the singular below two: « 0,5 crédit », « 1,8 crédit », « 2 crédits ». */
const creditWord = (value: number) =>
  t(value === 1 ? "credit" : "credits", value < 2 ? "crédit" : "crédits");

/** A price a reader can picture, for one model. */
export function priceLine(model: SnapshotModel | undefined): string | null {
  if (!model) return null;
  const amount = (usd: number, digits = 1) => {
    const value = Number(credits(usd).toFixed(digits));
    return `${number(value, digits)} ${creditWord(value)}`;
  };
  if (model.usdPerSecond)
    return t(
      `About ${amount(model.usdPerSecond)} per second of video`,
      `Environ ${amount(model.usdPerSecond)} par seconde de vidéo`,
    );
  if (model.credits !== undefined)
    return t(
      `About ${amount(model.credits / 100)} per image`,
      `Environ ${amount(model.credits / 100)} par image`,
    );
  if (model.usdPerMillionCharacters !== undefined) {
    // A page read aloud is about 3,000 characters.
    const page = (model.usdPerMillionCharacters * 3000) / 1_000_000;
    return t(
      `About ${amount(page, 2)} per page read aloud`,
      `Environ ${amount(page, 2)} par page lue`,
    );
  }
  if (model.usdPerMinute !== undefined)
    return t(
      `About ${amount(model.usdPerMinute * 60)} per hour of audio`,
      `Environ ${amount(model.usdPerMinute * 60)} par heure d’audio`,
    );
  if (model.usdPerTrack !== undefined)
    return t(
      `About ${amount(model.usdPerTrack)} per track`,
      `Environ ${amount(model.usdPerTrack)} par morceau`,
    );
  if (model.usdPerMinuteOfMusic !== undefined)
    return t(
      `About ${amount(model.usdPerMinuteOfMusic)} per minute of music`,
      `Environ ${amount(model.usdPerMinuteOfMusic)} par minute de musique`,
    );
  if (model.usdPerAudioSecond !== undefined)
    return t(
      `About ${amount(model.usdPerAudioSecond * 10)} per 10 seconds of sound`,
      `Environ ${amount(model.usdPerAudioSecond * 10)} pour 10 secondes de son`,
    );
  if (model.usdPerUpscale !== undefined)
    return t(
      `About ${amount(model.usdPerUpscale)} per enlargement`,
      `Environ ${amount(model.usdPerUpscale)} par agrandissement`,
    );
  if (model.usdPerMillion) {
    // A page is about 500 words, which is about 700 tokens written.
    const page = (model.usdPerMillion[1] * 700) / 1_000_000;
    return t(
      `About ${amount(page, 2)} per page written`,
      `Environ ${amount(page, 2)} par page rédigée`,
    );
  }
  return null;
}

/** The model's price in its own unit, to sort a category from cheapest to dearest. */
export function unitPrice(model: SnapshotModel | undefined): number {
  if (!model) return Number.POSITIVE_INFINITY;
  return (
    model.usdPerSecond ??
    (model.credits !== undefined ? model.credits / 100 : undefined) ??
    model.usdPerMillion?.[1] ??
    model.usdPerMillionCharacters ??
    model.usdPerMinute ??
    model.usdPerTrack ??
    model.usdPerMinuteOfMusic ??
    model.usdPerAudioSecond ??
    model.usdPerUpscale ??
    Number.POSITIVE_INFINITY
  );
}

/** The one line that tells versions of a kind apart: reach for text, length and sound for video. */
export function specLine(model: SnapshotModel | undefined): string | null {
  if (!model) return null;
  if (model.type === "text") {
    const parts = [
      model.context
        ? model.context >= 1_000_000
          ? t(
              `${number(model.context / 1_000_000, 1)}M context`,
              `contexte ${number(model.context / 1_000_000, 1)} M`,
            )
          : t(
              `${number(model.context / 1000, 0)}K context`,
              `contexte ${number(model.context / 1000, 0)} k`,
            )
        : null,
      model.traits?.includes("vision") ? t("reads images", "lit les images") : null,
      model.traits?.includes("tools")
        ? t("agent tools", "outils de l’agent")
        : t("no agent tools", "sans outils de l’agent"),
    ];
    return parts.filter(Boolean).join(" · ");
  }
  if (model.seconds) {
    const [low, high] = model.seconds;
    const length =
      low === high ? t(`${high} s`, `${high} s`) : t(`${low} to ${high} s`, `${low} à ${high} s`);
    return model.audio ? `${length} · ${t("with sound", "avec le son")}` : length;
  }
  return null;
}

/** Bands are per kind of work: a cheap video still costs more than a dear reply. */
export type PriceBand = 1 | 2 | 3 | 4;
export function priceBand(model: SnapshotModel | undefined): PriceBand | null {
  if (!model) return null;
  const steps = (value: number, limits: [number, number, number]): PriceBand =>
    value < limits[0] ? 1 : value < limits[1] ? 2 : value < limits[2] ? 3 : 4;
  if (model.usdPerSecond) return steps(model.usdPerSecond, [0.08, 0.16, 0.3]);
  if (model.credits !== undefined) return steps(model.credits, [3, 6, 12]);
  if (model.usdPerMillion) return steps(model.usdPerMillion[1], [1, 4, 12]);
  if (model.usdPerMillionCharacters !== undefined)
    return steps(model.usdPerMillionCharacters, [5, 20, 50]);
  if (model.usdPerMinute !== undefined) return steps(model.usdPerMinute, [0.004, 0.01, 0.05]);
  if (model.usdPerTrack !== undefined) return steps(model.usdPerTrack, [0.03, 0.08, 0.2]);
  if (model.usdPerMinuteOfMusic !== undefined)
    return steps(model.usdPerMinuteOfMusic, [0.03, 0.08, 0.2]);
  if (model.usdPerAudioSecond !== undefined)
    return steps(model.usdPerAudioSecond, [0.0007, 0.0015, 0.003]);
  return null;
}
export const priceBandLabel = (band: PriceBand): Copy =>
  (
    [
      ["Low cost", "Coût bas"],
      ["Moderate cost", "Coût modéré"],
      ["High cost", "Coût élevé"],
      ["Very high cost", "Coût très élevé"],
    ] as const
  )[band - 1];

export function contextLine(model: SnapshotModel | undefined): string | null {
  if (!model?.context) return null;
  // Round the page count to a figure nobody mistakes for a measurement.
  const pages = Math.round(model.context / 700 / 50) * 50;
  const size =
    model.context >= 1_000_000
      ? t(
          `${number(model.context / 1_000_000, 1)} million`,
          `${number(model.context / 1_000_000, 1)} million`,
        )
      : t(
          `${number(model.context / 1000, 0)} thousand`,
          `${number(model.context / 1000, 0)} mille`,
        );
  return t(
    `Reads ${size} tokens at once, about ${number(pages, 0)} pages`,
    `Lit ${size} de jetons d’un coup, environ ${number(pages, 0)} pages`,
  );
}

export const traitLabel: Record<string, Copy> = {
  vision: ["Reads images", "Lit les images"],
  tools: ["Uses Sub Rosa’s tools", "Utilise les outils de Sub Rosa"],
  reasoning: ["Thinks before answering", "Réfléchit avant de répondre"],
  code: ["Tuned for code", "Optimisé pour le code"],
};

export const modelTypeLabel: Record<string, Copy> = {
  text: ["Text", "Texte"],
  asr: ["Transcription", "Transcription"],
  image: ["Image", "Image"],
  imageEdit: ["Edit", "Retouche"],
  upscale: ["Upscale", "Agrandissement"],
  video: ["Text to video", "Texte vers vidéo"],
  imageToVideo: ["Image to video", "Image vers vidéo"],
  referenceToVideo: ["References to video", "Références vers vidéo"],
  tts: ["Voice", "Voix"],
  music: ["Audio", "Audio"],
  embedding: ["Search index", "Index de recherche"],
};

/** The provider's name, made unambiguous where two versions would otherwise share it. */
export const displayName = (model: SnapshotModel) => {
  const name = model.name ?? model.id;
  return model.id.startsWith("e2ee-") && !/e2ee/i.test(name) ? `${name} E2EE` : name;
};

// ---------------------------------------------------------------------------
// Depth: benchmarks, version history and the per-family detail chunks.

export type Benchmark = {
  id: string;
  name: string;
  publisher: string;
  category: Category;
  unit: string;
  scale: [number, number];
  higherIsBetter: boolean;
  url: string;
  measures: Copy;
  howToRead: Copy;
};

export type Score = {
  benchmark: string;
  model: string;
  external?: boolean;
  value: number;
  date: string;
  url: string;
  kind: "independent" | "vendor";
};

export type Release = {
  version: string;
  date: string;
  ids: string[];
  external?: boolean;
  changes: Copy[];
  source: string;
};

export type SpecRow = {
  version: string;
  ids: string[];
  params: string | null;
  activeParams: string | null;
  openWeights: boolean | null;
  license: string | null;
  maxOutput: number | null;
  inputs: string[];
  outputs: string[];
  languages: Copy | null;
  source: string;
};

export type FamilyDetail = {
  slug: string;
  strengths: Copy[];
  limits: Copy[];
  facts: Copy[];
  differentiator: Copy;
  signature: Copy[];
  releases: Release[];
  specs: SpecRow[];
  useCases: { title: Copy; prompt: Copy; why: Copy }[];
  rivals: { slug: string; verdict: Copy }[];
  sources: string[];
};

/** The light index every catalog page can read without a detail chunk. */
export type FamilyIndex = {
  slug: string;
  releases: { version: string; date: string; inCatalog: boolean }[];
};

export const benchmarks = (benchmarkData as unknown as { benchmarks: Benchmark[] }).benchmarks;
export const scores = (benchmarkData as unknown as { scores: Score[] }).scores;
const releaseIndex = new Map(
  (indexData as unknown as { families: FamilyIndex[] }).families.map((entry) => [
    entry.slug,
    entry,
  ]),
);
export const familyReleases = (slug: string) => releaseIndex.get(slug)?.releases ?? [];

export const benchmarkById = (id: string) => benchmarks.find((item) => item.id === id);
/** The benchmarks of a kind of work that have independent scores, the one covering the most families first. */
export function benchmarksFor(category: Category) {
  const coverage = (id: string) =>
    new Set(
      scores
        .filter(
          (score) => score.benchmark === id && score.kind === "independent" && !score.external,
        )
        .map((score) => familyOfModel(score.model)?.slug),
    ).size;
  return benchmarks
    .filter((item) => item.category === category && coverage(item.id) > 0)
    .sort((a, b) => coverage(b.id) - coverage(a.id));
}

/** How each language abbreviates a billion parameters ("753 Md", "753 Mrd."). */
const BILLIONS: Record<string, string> = {
  fr: "Md",
  de: "Mrd.",
  it: "Mld",
  es: "mil M",
  "pt-BR": "bi",
};

/** "753 Md" in French, "753B" in English: parameter counts as each language writes them. */
export function parameterCount(value: string) {
  const match = value.trim().match(/^([\d.,]+)\s*([KMBT])$/i);
  if (!match) return value;
  const amount = Number(match[1].replace(",", "."));
  const unit = match[2].toUpperCase();
  const billions = BILLIONS[websiteLocale()];
  if (!billions) return `${match[1]}${unit}`;
  if (unit === "T") return `${number(amount * 1000, 0)} ${billions}`;
  if (unit === "B") return `${number(amount, 1)} ${billions}`;
  return `${number(amount, 1)} ${unit === "M" ? "M" : "k"}`;
}

/** Joins abilities into one phrase: "Reads images, uses Sub Rosa’s tools". */
export const phraseList = (items: string[]) =>
  items
    .map((item, index) => (index === 0 ? item : item.charAt(0).toLowerCase() + item.slice(1)))
    .join(", ");

const better = (benchmark: Benchmark) => (a: number, b: number) =>
  benchmark.higherIsBetter ? b - a : a - b;

/** The catalog models measured on a benchmark, best first, one independent score per model. */
export function leaderboard(benchmarkId: string) {
  const benchmark = benchmarkById(benchmarkId);
  if (!benchmark) return [];
  const latest = new Map<string, Score>();
  for (const score of scores) {
    if (score.benchmark !== benchmarkId || score.kind !== "independent" || score.external) continue;
    const seen = latest.get(score.model);
    if (!seen || seen.date < score.date) latest.set(score.model, score);
  }
  const order = better(benchmark);
  return [...latest.values()].sort((a, b) => order(a.value, b.value));
}

/** A family's best showing on a benchmark: the score, its model and its rank among catalog models. */
export function familyStanding(family: Family, benchmarkId: string) {
  const board = leaderboard(benchmarkId);
  const index = board.findIndex((score) => family.ids.includes(score.model));
  if (index < 0) return null;
  return { score: board[index], rank: index + 1, of: board.length };
}

/** The benchmark that best describes a family: the headline one of its kind it is measured on. */
export function headlineBenchmark(family: Family) {
  return benchmarksFor(family.category).find((benchmark) => familyStanding(family, benchmark.id));
}

/** Every score of a family, its external predecessors included, for the version chart. */
export function familyScores(
  family: Family,
  detail: FamilyDetail | undefined,
  benchmarkId: string,
) {
  const labels = new Set(
    (detail?.releases ?? [])
      .filter((release) => release.external)
      .map((release) => release.version),
  );
  return scores.filter(
    (score) =>
      score.benchmark === benchmarkId &&
      (family.ids.includes(score.model) || (score.external && labels.has(score.model))),
  );
}

export const latestRelease = (slug: string) => {
  const list = familyReleases(slug).filter((release) => release.inCatalog);
  return list[list.length - 1];
};

/** "June 2026" or "17 June 2026", in the reader's language; a bare month stays a month. */
export function releaseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1, 12));
  return new Intl.DateTimeFormat(intlLocale(), {
    year: "numeric",
    month: "long",
    ...(day ? { day: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date);
}

export function formatScore(benchmark: Benchmark, value: number) {
  return benchmark.unit === "%"
    ? `${number(value, 1)} %`.replace(" %", t("%", " %"))
    : number(value, 0);
}

/** A model's price in credits, in the unit its kind of work is priced in (per page, image, second…). */
export function creditsPerUnit(model: SnapshotModel | undefined): number | null {
  if (!model) return null;
  if (model.usdPerSecond) return model.usdPerSecond * 100;
  if (model.credits !== undefined) return model.credits;
  if (model.usdPerMillion) return (model.usdPerMillion[1] * 700) / 10_000;
  if (model.usdPerMillionCharacters !== undefined)
    return (model.usdPerMillionCharacters * 3000) / 10_000;
  if (model.usdPerMinute !== undefined) return model.usdPerMinute * 6000;
  if (model.usdPerTrack !== undefined) return model.usdPerTrack * 100;
  if (model.usdPerMinuteOfMusic !== undefined) return model.usdPerMinuteOfMusic * 100;
  if (model.usdPerAudioSecond !== undefined) return model.usdPerAudioSecond * 1000;
  return null;
}

export const creditsLabel = (value: number) =>
  t(
    `${number(value, value < 1 ? 2 : 1)} credits`,
    `${number(value, value < 1 ? 2 : 1)} ${value < 2 ? "crédit" : "crédits"}`,
  );
