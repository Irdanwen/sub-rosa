// The model "Default" stands for in a chat's model picker: the one the backend
// runs a chat on when the chat names none (`providers::generation_model` in
// Rust, which already reads the saved default and what protected mode hides).
// Asked of the backend rather than guessed, so the context gauge reads the
// window of the model that will really answer.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type DefaultChatModelDto = { modelId: string };

export async function defaultChatModelId(): Promise<string> {
  const { modelId } = await invoke<DefaultChatModelDto>("default_chat_model");
  return modelId.trim();
}

/** The default chat model's id, or `undefined` until it is known (or when it
 * cannot be read: the gauge is then not drawn rather than drawn wrong). */
export function useDefaultChatModelId(): string | undefined {
  const [modelId, setModelId] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    defaultChatModelId()
      .then((id) => {
        if (!cancelled && id) setModelId(id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return modelId;
}
