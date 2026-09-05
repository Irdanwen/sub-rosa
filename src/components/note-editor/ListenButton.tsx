import { t } from "../../lib/i18n";
import { IconPause } from "central-icons-filled/IconPause";
import { IconPlay } from "central-icons-filled/IconPlay";
import { useEffect, useRef, useState } from "react";
import { noteSpeechUrl } from "../../lib/note-speech";
import { DotSpinner } from "../DotSpinner";

/**
 * The spoken recap: a note, read out loud, for the walk home.
 *
 * Deliberately one button and no player chrome. The audio element is real
 * (not Web Audio) so the system's own controls — lock screen, headphones,
 * car — drive it, which is the entire point of listening to a note while
 * doing something else.
 */
export function ListenButton({ noteId, content }: { noteId: string; content: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "failed">("idle");

  // A new note (or leaving the editor) must not keep talking.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);
  useEffect(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setState("idle");
  }, [noteId]);

  const toggle = async () => {
    if (state === "playing") {
      audioRef.current?.pause();
      setState("idle");
      return;
    }
    if (audioRef.current) {
      await audioRef.current.play().catch(() => {});
      setState("playing");
      return;
    }
    setState("loading");
    try {
      const url = await noteSpeechUrl(noteId, content);
      if (!url) {
        setState("failed");
        return;
      }
      const audio = new Audio(url);
      audio.addEventListener("ended", () => setState("idle"));
      audio.addEventListener("error", () => setState("failed"));
      audioRef.current = audio;
      await audio.play();
      setState("playing");
    } catch {
      // Speech is a convenience: a failure says so quietly and leaves the
      // note exactly as it was.
      setState("failed");
    }
  };

  if (!content.trim()) return null;

  return (
    <button
      type="button"
      className="note-listen"
      data-state={state}
      disabled={state === "loading"}
      aria-label={state === "playing" ? t("Pause the recap") : t("Listen to the recap")}
      title={state === "failed" ? t("The recap could not be read aloud") : t("Listen")}
      onClick={() => void toggle()}
    >
      {state === "loading" ? (
        <DotSpinner />
      ) : state === "playing" ? (
        <IconPause size={13} />
      ) : (
        <IconPlay size={13} />
      )}
      <span>{state === "playing" ? t("Pause") : t("Listen")}</span>
    </button>
  );
}
