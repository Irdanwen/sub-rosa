/**
 * When a card comes back: the SM-2 of `src-tauri/src/study/schedule.rs`,
 * with its four answers, ported line for line. The constants are Rust's
 * (`packages/chat-core/web/study.json`); the tests replay Rust's own answers
 * for the same cards.
 */
import exported from "@subrosa/chat-core/web/study.json";

export interface StudyExport {
  promptVersion: number;
  prompt: string;
  minEase: number;
  startEase: number;
  relearnMinutes: number;
  maxIntervalDays: number;
  maxCardsPerAdd: number;
  maxSideChars: number;
  maxDeckChars: number;
}
export const STUDY = exported as unknown as StudyExport;

export type Grade = "again" | "hard" | "good" | "easy";
export const GRADES: Grade[] = ["again", "hard", "good", "easy"];

export interface CardState {
  ease: number;
  intervalDays: number;
  repetitions: number;
  lapses: number;
}
export const NEW_CARD: CardState = {
  ease: STUDY.startEase,
  intervalDays: 0,
  repetitions: 0,
  lapses: 0,
};

const QUALITY: Record<Grade, number> = { again: 1, hard: 3, good: 4, easy: 5 };
const DAY_MS = 86_400_000;

/** Rust's `f64::round`: halves away from zero (the values here are positive). */
const round = (value: number) => Math.sign(value) * Math.round(Math.abs(value));

/** The state after an answer, and when the card is due again. */
export function review(state: CardState, grade: Grade, now: Date): { next: CardState; due: Date } {
  const q = QUALITY[grade];
  const eased = state.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (grade === "again")
    return {
      next: {
        ease: Math.max(state.ease - 0.2, STUDY.minEase),
        intervalDays: 0,
        repetitions: 0,
        lapses: state.lapses + 1,
      },
      due: new Date(now.getTime() + STUDY.relearnMinutes * 60_000),
    };
  const repetitions = state.repetitions + 1;
  const previous = Math.max(state.intervalDays, 1);
  const base = repetitions === 1 ? 1 : repetitions === 2 ? 6 : round(previous * state.ease);
  let interval: number;
  if (grade === "hard" && repetitions > 2) interval = Math.max(round(previous * 1.2), 1);
  else if (grade === "easy") interval = Math.max(round(base * 1.3), base + 1);
  else interval = base;
  interval = Math.min(Math.max(interval, 1), STUDY.maxIntervalDays);
  return {
    next: {
      ease: Math.max(eased, STUDY.minEase),
      intervalDays: interval,
      repetitions,
      lapses: state.lapses,
    },
    due: new Date(now.getTime() + interval * DAY_MS),
  };
}
