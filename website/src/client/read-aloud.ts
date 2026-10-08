/**
 * "Read aloud" in the browser: the reply cut into chunks the way the app cuts
 * it (`@subrosa/chat-core/speakable-text`), each rendered by Carpe Diem's
 * speech route and played through Web Audio. Web Audio, not an <audio>
 * element: the bytes are decoded in memory, so no media URL is needed and the
 * site's CSP stays as narrow as it is.
 */
import { speechChunks } from "@subrosa/chat-core/speakable-text";
import { type Operator, speech } from "./carpe-diem";
import { spokenReply } from "./export";

export interface Reading {
  stop(): void;
  done: Promise<void>;
}

export function readAloud(
  operator: Operator,
  key: string,
  content: string,
  voice: { model: string; voice?: string },
  context: AudioContext = new AudioContext(),
): Reading {
  const controller = new AbortController();
  let source: AudioBufferSourceNode | null = null;
  const done = (async () => {
    const chunks = speechChunks(spokenReply(content));
    // The next chunk renders while the current one plays.
    let next = chunks.length ? speech(operator, key, chunks[0], voice, controller.signal) : null;
    for (let index = 0; index < chunks.length && next; index++) {
      const bytes = await next;
      next =
        index + 1 < chunks.length
          ? speech(operator, key, chunks[index + 1], voice, controller.signal)
          : null;
      if (controller.signal.aborted) return;
      const buffer = await context.decodeAudioData(bytes);
      if (controller.signal.aborted) return;
      await new Promise<void>((resolve) => {
        source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => resolve();
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
        source.start();
      });
    }
  })().finally(() => {
    void context.close().catch(() => undefined);
  });
  return {
    stop() {
      controller.abort();
      try {
        (source as AudioBufferSourceNode | null)?.stop();
      } catch {
        // Already stopped.
      }
    },
    done,
  };
}
