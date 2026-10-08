/**
 * One utterance transcribed by Carpe Diem: `POST /v1/audio/transcriptions`,
 * a whole-file multipart request (there is no streaming transcription,
 * ADR-0093), the same fields the app's sidecar sends.
 */
import { CarpeDiemError, failure, type Operator } from "../carpe-diem";
import { encodeWav } from "./wav";

export async function transcribe(
  operator: Operator,
  key: string,
  samples: ArrayLike<number>,
  sampleRate: number,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("model", model);
  form.append("response_format", "json");
  form.append(
    "file",
    new Blob([encodeWav(samples, sampleRate)], { type: "audio/wav" }),
    "audio.wav",
  );
  const response = await operator.fetch(`${operator.root}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    body: form,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  });
  // No speech in the audio is answered 400 upstream: nothing was heard.
  if (response.status === 400) return "";
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { text?: unknown };
  if (typeof body.text !== "string")
    throw new CarpeDiemError("invalid_transcription", 502, "The transcription was empty.");
  return body.text;
}
