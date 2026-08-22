/**
 * Navigation hook for chat blocks that point INSIDE the app (the notes card).
 * The cards render deep inside the markdown tree of either shell, so instead
 * of threading a navigation callback through every renderer, they dispatch
 * one window event and each shell's root answers it with its own note-opening
 * path (`handleSelectNote` on desktop, `openNote` on the phone) — the same
 * decoupling the agent-events channel uses.
 */

export const OPEN_NOTE_FROM_CHAT_EVENT = "june:open-note-from-chat";

export type OpenNoteFromChatDetail = { noteId: string };

export function requestOpenNoteFromChat(noteId: string) {
  window.dispatchEvent(
    new CustomEvent<OpenNoteFromChatDetail>(OPEN_NOTE_FROM_CHAT_EVENT, {
      detail: { noteId },
    }),
  );
}
