import { useEffect, useRef, useState } from "react";

/**
 * The chat's opening ground: light through water, behind the greeting.
 *
 * It exists only while the chat is empty. The moment there is a conversation
 * to read it fades out and unmounts, because a moving image behind a paragraph
 * you are trying to read is a cost, not a flourish — and a looping video that
 * plays for the length of a session is a battery bill nobody asked for.
 *
 * Three things it deliberately does:
 *
 * - **Ships a poster.** WKWebView does not paint a <video>'s first frame
 *   without one, and iOS Low Power Mode refuses autoplay outright. In both
 *   cases the poster is what the person sees, so it is the first frame of the
 *   delivered loop rather than a frame of the source — otherwise the still and
 *   the video disagree and it jumps when playback starts.
 * - **Is muted.** A decorative background has no business making sound, and
 *   staying silent also keeps it out of the iOS audio session entirely
 *   (audio/ios_session.rs), so it can never interrupt music or a recording.
 * - **Pauses when the app is not in front.** iOS freezes the webview on its
 *   own; Android and the browser preview do not.
 *
 * Under prefers-reduced-motion or prefers-reduced-transparency no <video> is
 * mounted at all — the poster stands in. Reduced motion means fewer and
 * gentler, not nothing, and a still image is not motion.
 */

/** Matches --t-slow. The element is removed once the fade has run. */
const FADE_MS = 240;

const POSTER = "/ambient/chat-ambient.jpg";
const CLIP = "/ambient/chat-ambient.mp4";

function prefersStill(): boolean {
  // Optional all the way down on purpose. This is a decorative background: if
  // the query cannot be answered it must fall back to showing something, never
  // throw and take the conversation with it.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)")?.matches === true ||
    window.matchMedia("(prefers-reduced-transparency: reduce)")?.matches === true
  );
}

type ChatAmbientProps = {
  active: boolean;
  /**
   * Fires with `true` on mount and `false` once the fade has finished. The
   * screen re-grounds itself to the ink palette while the image is there, and
   * that has to last exactly as long as the image does — dropping it the
   * instant the conversation starts leaves a quarter of a second of cream
   * chrome standing on a dark photograph.
   */
  onPresenceChange?: (present: boolean) => void;
};

export function ChatAmbient({ active, onPresenceChange }: ChatAmbientProps) {
  // Kept mounted through the fade-out, then dropped.
  const [present, setPresent] = useState(active);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Read once per mount: a person changing the setting mid-session gets it on
  // the next chat, and re-rendering a <video> on a media-query change would
  // restart playback.
  const [still] = useState(prefersStill);

  useEffect(() => {
    if (active) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const timer = window.setTimeout(() => setPresent(false), FADE_MS);
    // Cleared if the chat empties again mid-fade — a transition retargets from
    // wherever it is, so the image simply comes back.
    return () => window.clearTimeout(timer);
  }, [active, present]);

  useEffect(() => {
    onPresenceChange?.(present);
  }, [present, onPresenceChange]);

  useEffect(() => {
    if (!present || still) return;
    const onVisibility = () => {
      const video = videoRef.current;
      if (!video) return;
      if (document.hidden) {
        video.pause();
      } else {
        // Autoplay can be refused (Low Power Mode); the poster covers it.
        void video.play().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [present, still]);

  if (!present) return null;

  return (
    <div className="mobile-chat-ambient" data-leaving={active ? undefined : "true"} aria-hidden>
      {still ? (
        <div className="mobile-chat-ambient-still" style={{ backgroundImage: `url(${POSTER})` }} />
      ) : (
        <video
          ref={videoRef}
          className="mobile-chat-ambient-clip"
          src={CLIP}
          poster={POSTER}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
        />
      )}
      {/* Ink at the bottom, so the composer and the tab bar below it sit on a
       * settled ground instead of on the brightest part of the light. */}
      <div className="mobile-chat-ambient-scrim" />
    </div>
  );
}
