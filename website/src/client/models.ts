/**
 * The chat models a person can pick in the browser: the public catalog the
 * site already publishes (`models/snapshot.json`), text models that call
 * tools, enriched with Carpe Diem's live list when it answers (context
 * window, reasoning effort, voices). Nothing here needs a key.
 */
import { supportsReasoningEffort } from "@subrosa/chat-core/reasoning-effort";
import snapshotData from "../models/snapshot.json";
import { AGENT_LITE } from "./codec";
import { type LiveModel, liveModels, type Operator } from "./carpe-diem";

export interface ChatModel {
  id: string;
  name: string;
  contextTokens?: number;
  supportsReasoningEffort: boolean;
  privacy?: string;
}

interface SnapshotModel {
  id: string;
  type: string;
  name?: string;
  context?: number;
  privacy?: string;
  traits?: string[];
}
const snapshot = (snapshotData as { models: SnapshotModel[] }).models;

/** The models of the frozen catalog that can run the agent's tools. */
export function catalogChatModels(): ChatModel[] {
  return snapshot
    .filter((model) => model.type === "text" && model.traits?.includes("tools"))
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextTokens: model.context,
      supportsReasoningEffort: false,
      privacy: model.privacy,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The catalog, corrected by what Carpe Diem says today: a model it no longer
 * lists is dropped, the context window and the effort flag are its own. */
export function mergeLive(models: ChatModel[], live: LiveModel[]): ChatModel[] {
  if (!live.length) return models;
  const byId = new Map(live.map((model) => [model.id, model]));
  return models
    .filter((model) => byId.has(model.id))
    .map((model) => {
      const current = byId.get(model.id) as LiveModel;
      return {
        ...model,
        contextTokens: current.contextTokens ?? model.contextTokens,
        supportsReasoningEffort: supportsReasoningEffort({
          supportsReasoningEffort: current.supportsReasoningEffort,
        }),
      };
    });
}

export async function loadChatModels(operator: Operator, signal?: AbortSignal) {
  const catalog = catalogChatModels();
  try {
    const live = await liveModels(operator, signal);
    return { models: mergeLive(catalog, live), live };
  } catch {
    return { models: catalog, live: [] as LiveModel[] };
  }
}

/** The app's default chat model, else the first one listed. */
export function defaultChatModel(models: ChatModel[]): string {
  return models.find((model) => model.id === AGENT_LITE.defaultModel)?.id ?? models[0]?.id ?? "";
}

/** The read-aloud engine: Kokoro when Carpe Diem lists it, else the first
 * speech model, with its first voice. */
export function speechVoice(live: LiveModel[]): { model: string; voice?: string } {
  const engines = live.filter((model) => model.type === "tts");
  const engine = engines.find((model) => model.id === "tts-kokoro") ?? engines[0];
  return engine
    ? { model: engine.id, voice: engine.voices?.[0] }
    : { model: "tts-kokoro", voice: "af_sky" };
}
