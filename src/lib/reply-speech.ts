// "Read aloud" on a chat reply, on the desktop and the phone.
//
// The same machinery as the spoken recap of a note (note-speech.ts): the
// one-call `/audio/speech` rail through the fork's media proxy, in the voice
// the person chose in Settings (voice-preference.ts), and a real <audio> element
// so the system's own controls (lock screen, headphones, keyboard media keys)
// drive it. What it adds is for replies: the text is cut into chunks
// (speakable-text.ts) so the first sentence plays in seconds while the rest
// renders behind it, and only one reply speaks at a time. Pressing another
// reply's button stops the first; pressing the playing one stops it.
//
// Rendered audio is kept for the session (by reply, chunk and voice), so
// listening to the same reply twice does not pay twice.

import { useCallback, useSyncExternalStore } from "react";
import { PRODUCT_NAME } from "./branding";
import { t } from "./i18n";
import { speakableReply, speechChunks } from "./speakable-text";
import { renderPreferredSpeech, voicePreferenceKey } from "./voice-preference";

export type ReplySpeechStatus = "idle" | "loading" | "playing" | "failed";

export type ReplySpeechState = {
  /** The reply being read, or the last one that failed. */
  key: string | null;
  status: ReplySpeechStatus;
};

/** The few things an `<audio>` does that the player needs, so a test can
 * stand in for it. */
export type SpeechAudio = {
  src: string;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: "ended" | "error", listener: () => void): void;
};

export type ReplySpeechDeps = {
  /** Renders one chunk and answers a playable URL. */
  render: (text: string, signal: AbortSignal) => Promise<string>;
  createAudio: () => SpeechAudio;
  /** What the rendered audio sounds like: a chunk rendered in another voice
   * is not replayed. */
  voiceKey?: () => string;
};

/** Rendered chunks kept, oldest dropped first. */
const CACHE_LIMIT = 48;

export function createReplySpeechPlayer(deps: ReplySpeechDeps) {
  let state: ReplySpeechState = { key: null, status: "idle" };
  const listeners = new Set<() => void>();
  const cache = new Map<string, string>();
  let session: { key: string; controller: AbortController; audio: SpeechAudio } | null = null;

  function set(next: ReplySpeechState) {
    state = next;
    for (const listener of listeners) listener();
  }

  function remember(cacheKey: string, url: string) {
    cache.set(cacheKey, url);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      const dropped = cache.get(oldest);
      cache.delete(oldest);
      if (dropped?.startsWith("blob:")) URL.revokeObjectURL(dropped);
    }
  }

  function render(key: string, index: number, text: string, signal: AbortSignal) {
    const cacheKey = `${key}:${index}:${text.length}:${deps.voiceKey?.() ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    return deps.render(text, signal).then((url) => {
      remember(cacheKey, url);
      return url;
    });
  }

  function stop() {
    if (!session) return;
    session.controller.abort();
    session.audio.pause();
    session = null;
    set({ key: null, status: "idle" });
  }

  async function play(key: string, markdown: string) {
    stop();
    const chunks = speechChunks(speakableReply(markdown));
    if (!chunks.length) return;
    const controller = new AbortController();
    const audio = deps.createAudio();
    const current = { key, controller, audio };
    session = current;
    set({ key, status: "loading" });
    const live = () => session === current && !controller.signal.aborted;
    // Every chunk starts rendering one step ahead of its turn: the next is
    // requested as soon as the current one starts playing.
    const pending: Promise<string>[] = [];
    const chunkUrl = (index: number) => {
      pending[index] ??= render(key, index, chunks[index], controller.signal);
      return pending[index];
    };
    const fail = () => {
      if (!live()) return;
      controller.abort();
      audio.pause();
      session = null;
      set({ key, status: "failed" });
    };
    let index = 0;
    const playChunk = async () => {
      try {
        const url = await chunkUrl(index);
        if (!live()) return;
        audio.src = url;
        await audio.play();
        if (!live()) return;
        set({ key, status: "playing" });
        if (index + 1 < chunks.length) void chunkUrl(index + 1).catch(() => undefined);
      } catch {
        fail();
      }
    };
    audio.addEventListener("ended", () => {
      if (!live()) return;
      index += 1;
      if (index >= chunks.length) {
        session = null;
        set({ key: null, status: "idle" });
        return;
      }
      set({ key, status: "loading" });
      void playChunk();
    });
    audio.addEventListener("error", fail);
    announce(stop);
    await playChunk();
  }

  return {
    play,
    stop,
    /** Plays `key`, or stops it when it is the one playing or loading. */
    toggle(key: string, markdown: string) {
      if (state.key === key && (state.status === "playing" || state.status === "loading")) {
        stop();
        return Promise.resolve();
      }
      return play(key, markdown);
    },
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ReplySpeechPlayer = ReturnType<typeof createReplySpeechPlayer>;

/** Names the playing reply to the system's media controls and lets them stop
 * it. Best effort: a webview without Media Session simply has no title. */
function announce(stop: () => void) {
  try {
    const media = navigator.mediaSession;
    if (!media || typeof MediaMetadata === "undefined") return;
    media.metadata = new MediaMetadata({ title: t("Reply"), artist: PRODUCT_NAME });
    media.setActionHandler("stop", stop);
  } catch {
    // Older engines throw on an action they do not know; nothing to do.
  }
}

/** The app's one reply reader. */
export const replySpeech = createReplySpeechPlayer({
  render: (text, signal) => renderPreferredSpeech(text, { signal }),
  createAudio: () => new Audio(),
  voiceKey: () => voicePreferenceKey(),
});

/** The reading state of one reply, and the press that starts or stops it. */
export function useReplySpeech(key: string, player: ReplySpeechPlayer = replySpeech) {
  const state = useSyncExternalStore(player.subscribe, player.getState);
  const status: ReplySpeechStatus = state.key === key ? state.status : "idle";
  const toggle = useCallback(
    (markdown: string) => void player.toggle(key, markdown),
    [player, key],
  );
  return { status, toggle };
}
