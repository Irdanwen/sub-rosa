import { invoke } from "@tauri-apps/api/core";
import type { PurgeRecordingsResultDto } from "./tauri";

/** How many days after transcription recordings are deleted, on every
 * device and in the account (ADR-0112); `null` keeps them. */
export async function recordingsRetention(): Promise<number | null> {
  return invoke<number | null>("recordings_retention");
}

/** Chooses that age for the whole account and applies it at once here. */
export async function setRecordingsRetention(
  days: number | null,
): Promise<PurgeRecordingsResultDto> {
  return invoke<PurgeRecordingsResultDto>("set_recordings_retention", { days });
}
