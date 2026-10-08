/**
 * Protected mode's rules, as pure functions of the switches and the time of
 * day (ADR-0084 and its addendum), the browser's copy of
 * `protected_mode::guards` and `protected_mode::restrictions`. The words and
 * the adult markers are Rust's (`packages/chat-core/web/protected.json`).
 */
import exported from "@subrosa/chat-core/web/protected.json";
import snapshotData from "../../models/snapshot.json";
import { t } from "../../lib/i18n";
import { type Guards, OPEN_GUARDS } from "../feature";

export interface ProtectedExport {
  adultMarkers: string[];
  promptBlock: string;
  pin: { minDigits: number; maxDigits: number; maxFailures: number; lockoutSeconds: number };
  refusals: {
    model: string;
    quietHours: string;
    mediaOff: string;
    voiceOff: string;
    wrongPin: string;
    pinFormat: string;
    locked: string;
    quietHoursInvalid: string;
  };
}
export const PROTECTED = exported as ProtectedExport;

const MINUTES_PER_DAY = 24 * 60;

/** A daily window in minutes after local midnight: `start` is in it, `end`
 * is not, and an end before the start runs over midnight. */
export interface QuietHours {
  startMinute: number;
  endMinute: number;
}

/** The switches, all off by default, in force only while protected mode is on. */
export interface Restrictions {
  quietHours?: QuietHours;
  memoryOff: boolean;
  mediaOff: boolean;
  voiceOff: boolean;
  pastChatsOff: boolean;
}
export const NO_RESTRICTIONS: Restrictions = {
  memoryOff: false,
  mediaOff: false,
  voiceOff: false,
  pastChatsOff: false,
};

export function windowContains(window: QuietHours, minute: number): boolean {
  const at = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (window.startMinute <= window.endMinute)
    return at >= window.startMinute && at < window.endMinute;
  return at >= window.startMinute || at < window.endMinute;
}

export function quietAt(restrictions: Restrictions, minute: number): boolean {
  return !!restrictions.quietHours && windowContains(restrictions.quietHours, minute);
}

/** A window that could not be meant: out of the day, or empty. */
export function validWindow(window: QuietHours | undefined): boolean {
  if (!window) return true;
  const inDay =
    Number.isInteger(window.startMinute) &&
    Number.isInteger(window.endMinute) &&
    window.startMinute >= 0 &&
    window.endMinute >= 0 &&
    window.startMinute < MINUTES_PER_DAY &&
    window.endMinute < MINUTES_PER_DAY;
  return inDay && window.startMinute !== window.endMinute;
}

/** Minutes after local midnight. */
export function localMinute(now = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

function hasMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return PROTECTED.adultMarkers.some((marker) => lower.includes(marker));
}

/** `is_adult_model`: a marker in the id, the name or a trait. */
export function isAdultModel(id: string, name = "", traits: string[] = []): boolean {
  return [id, name, ...traits].some(hasMarker);
}

const snapshotTraits = new Map(
  (snapshotData as { models: { id: string; traits?: string[] }[] }).models.map((model) => [
    model.id,
    model.traits ?? [],
  ]),
);

/** The traits the public catalog gives a model, for the predicate. */
export function traitsOf(id: string): string[] {
  return snapshotTraits.get(id) ?? [];
}

/** Every refusal, in the page's language. The English is Rust's own. */
export const refusal = {
  model: () =>
    t(PROTECTED.refusals.model, "Le mode protégé bloque ce modèle. Choisissez-en un autre."),
  quietHours: () =>
    t(
      PROTECTED.refusals.quietHours,
      "Les heures calmes sont en cours. Le chat et le Studio sont en pause jusqu’à leur fin.",
    ),
  mediaOff: () =>
    t(PROTECTED.refusals.mediaOff, "Le mode protégé a coupé la création d’images et de vidéos."),
  voiceOff: () =>
    t(PROTECTED.refusals.voiceOff, "Le mode protégé a coupé les conversations vocales."),
  wrongPin: () => t(PROTECTED.refusals.wrongPin, "Ce code n’est pas le bon."),
  pinFormat: () => t(PROTECTED.refusals.pinFormat, "Utilisez un code de 4 à 6 chiffres."),
  locked: () =>
    t(PROTECTED.refusals.locked, "Trop de codes erronés. Attendez 30 secondes, puis réessayez."),
  quietHoursInvalid: () =>
    t(
      PROTECTED.refusals.quietHoursInvalid,
      "Choisissez des heures calmes qui commencent et finissent à des heures différentes.",
    ),
};

/** What protected mode lets through now, from its state and the clock. */
export function guardsFor(
  enabled: boolean,
  restrictions: Restrictions,
  minute: number = localMinute(),
): Guards {
  if (!enabled) return OPEN_GUARDS;
  const quiet = quietAt(restrictions, minute);
  return {
    on: true,
    models: (models) =>
      models.filter((model) => !isAdultModel(model.id, model.name ?? "", traitsOf(model.id))),
    chatRefusal: (model) => {
      if (model && isAdultModel(model, "", traitsOf(model))) return refusal.model();
      return quiet ? refusal.quietHours() : null;
    },
    memory: !restrictions.memoryOff,
    pastChats: !restrictions.pastChatsOff,
    voice: !restrictions.voiceOff && !quiet,
    media: !restrictions.mediaOff && !quiet,
    promptBlock: PROTECTED.promptBlock,
  };
}

/** Why a voice conversation may not start or go on, or null. */
export function voiceRefusal(guards: Guards): string | null {
  if (guards.voice) return null;
  return guards.chatRefusal("") ?? refusal.voiceOff();
}
