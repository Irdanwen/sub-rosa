/**
 * What a voice conversation runs on, from the live catalog: the transcription
 * model, and the price said before the first conversation (ADR-0093 decision
 * 9, `src/lib/voice/voice-cost.ts`). A turn with a picture is routed by the
 * page like any other (`attachments.ts::visionModelFor`).
 */
import { failure, type LiveModel, type Operator } from "../carpe-diem";

/** The transcription model the app's settings default to. */
export const DEFAULT_TRANSCRIPTION_MODEL = "nvidia/parakeet-tdt-0.6b-v3";
/** Half a minute of the person speaking, half of the assistant reading at
 * about fifteen characters a second (the app's `voice-cost.ts`). */
export const HEARD_SECONDS_PER_MINUTE = 30;
export const SPOKEN_CHARACTERS_PER_MINUTE = 450;

/** The app's default transcription model when Carpe Diem lists it, else the
 * first transcription model it lists. */
export function transcriptionModel(live: LiveModel[]): string {
  const engines = live.filter((model) => model.type === "asr");
  return (
    engines.find((model) => model.id === DEFAULT_TRANSCRIPTION_MODEL)?.id ??
    engines[0]?.id ??
    DEFAULT_TRANSCRIPTION_MODEL
  );
}

export interface PriceRow {
  model: string;
  /** USD: per million characters for speech, per audio minute for
   * transcription, as the operator's `/pricing` lists them. */
  inputPrice: number;
}

/** The operator's public price list. Empty when it cannot be read: a price
 * that leaves out a part is not said at all. */
export async function priceList(operator: Operator, signal?: AbortSignal): Promise<PriceRow[]> {
  try {
    const response = await operator.fetch(`${operator.root}/pricing`, {
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) throw await failure(response);
    const body = (await response.json()) as { models?: Record<string, unknown>[] };
    return (body.models ?? [])
      .filter((row) => typeof row.model === "string" && typeof row.inputPrice === "number")
      .map((row) => ({ model: String(row.model), inputPrice: Number(row.inputPrice) }));
  } catch {
    return [];
  }
}

/** Listening and speaking for a minute of conversation, in credits (one
 * credit is one cent), or null when either price is unknown. */
export function creditsPerMinute(
  prices: PriceRow[],
  speechModel: string,
  transcription: string,
): number | null {
  const speech = prices.find((row) => row.model === speechModel)?.inputPrice;
  const heard = prices.find((row) => row.model === transcription)?.inputPrice;
  if (speech === undefined || heard === undefined) return null;
  const usd =
    (speech * SPOKEN_CHARACTERS_PER_MINUTE) / 1_000_000 + (heard * HEARD_SECONDS_PER_MINUTE) / 60;
  return Math.round(usd * 100 * 100) / 100;
}
