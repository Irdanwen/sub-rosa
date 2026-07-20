// Optional prompt improvement for image generation: one small chat-completions
// call that rewrites a short prompt into a rich one. Best-effort by design -
// any failure returns the original prompt so generation never blocks on it.

import { mediaJson } from "./client";
import type { MediaCatalog } from "./types";

const ENHANCE_SYSTEM =
  "You expand short image prompts into rich, specific image-generation prompts: subject, setting, lighting, mood, composition, style. Keep the user's intent and language. Reply with the improved prompt only - no preamble, no quotes, no explanations.";

/** Small, fast text models make the best prompt rewriters; fall back to the
 * first text model the backend offers. */
const ENHANCE_MODEL_PREFERENCE = ["llama-3.2-3b", "qwen3-5-9b", "mistral-small", "llama-3.3-70b"];

export function pickEnhanceModel(catalog: MediaCatalog): string | undefined {
  const text = catalog.models.filter((model) => model.mediaType === "text" && !model.offline);
  for (const preferred of ENHANCE_MODEL_PREFERENCE) {
    const hit = text.find((model) => model.id.toLowerCase().includes(preferred));
    if (hit) return hit.id;
  }
  return text[0]?.id;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export async function enhanceImagePrompt(
  prompt: string,
  catalog: MediaCatalog,
  signal?: AbortSignal,
): Promise<string> {
  const model = pickEnhanceModel(catalog);
  if (!model || !prompt.trim()) return prompt;
  try {
    const response = await mediaJson<ChatResponse>(
      "/chat/completions",
      {
        model,
        messages: [
          { role: "system", content: ENHANCE_SYSTEM },
          { role: "user", content: prompt.trim() },
        ],
        max_tokens: 400,
        temperature: 0.7,
      },
      signal,
    );
    const content = response.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : prompt;
  } catch {
    return prompt;
  }
}
