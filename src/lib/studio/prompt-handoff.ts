// A prompt carried from another tab into Studio's image panel: "Generate an
// image" on the chat's opening hands over what was typed and switches tabs.
// In memory on purpose. It lives for one tab switch, and a prompt left over
// from a session the app no longer remembers would be a surprise, not a help.

let pending: string | undefined;

/** Leaves a prompt for the image panel to open with. */
export function handOffImagePrompt(prompt: string): void {
  pending = prompt.trim() || undefined;
}

/** The prompt left for the image panel, once: reading it clears it. */
export function takeImagePrompt(): string | undefined {
  const prompt = pending;
  pending = undefined;
  return prompt;
}
