// Cloned voices (ADR-0077): a voice made once from a sample of one's own
// voice, spoken with for weeks. The sample stays on the device (Rust,
// `carpe_diem/voices.rs`); the provider handle is reminted from it whenever
// it nears its seven days, or when the backend says it is gone.
//
// Everywhere else a cloned voice is the reference `cloned:<id>`, stable for
// as long as the voice exists - in a workflow node, in a bible casting - and
// resolved to a handle only at the moment of speaking.

import { invoke } from "@tauri-apps/api/core";

export interface ClonedVoice {
  id: string;
  name: string;
  /** The one engine it was made for. */
  model: string;
  createdAt: string;
  consentedAt: string;
}

export const CLONED_VOICE_PREFIX = "cloned:";

export function clonedVoiceRef(id: string): string {
  return `${CLONED_VOICE_PREFIX}${id}`;
}

export function clonedVoiceId(voice: string | undefined): string | undefined {
  return voice?.startsWith(CLONED_VOICE_PREFIX)
    ? voice.slice(CLONED_VOICE_PREFIX.length)
    : undefined;
}

export function listClonedVoices(): Promise<ClonedVoice[]> {
  return invoke<ClonedVoice[]>("cloned_voice_list");
}

export function deleteClonedVoice(id: string): Promise<void> {
  return invoke("cloned_voice_delete", { id });
}

/** The provider handle for a voice; `refresh` mints a new one. */
export function clonedVoiceHandle(id: string, refresh = false): Promise<string> {
  return invoke<string>("cloned_voice_handle", { id, refresh });
}

/** File bytes as base64, without a data: prefix. */
async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export async function createClonedVoice(request: {
  name: string;
  model: string;
  sample: Blob;
  /** The sample's file extension (`m4a`, `wav`...). */
  extension: string;
  consent: boolean;
}): Promise<ClonedVoice> {
  return invoke<ClonedVoice>("cloned_voice_create", {
    request: {
      name: request.name,
      model: request.model,
      sampleBase64: await fileBase64(request.sample),
      extension: request.extension,
      consent: request.consent,
    },
  });
}

/** The extension of a picked file, for the sample's own format. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}
