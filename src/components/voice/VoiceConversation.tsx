// The voice conversation surface (ADR-0093), on the desktop and the phone:
// a level orb, captions, mute, the camera (phone) or the screen (Mac), and
// end. The loop runs in Rust; this surface starts it, shows it, and hands
// the turns it asks for to the shell's chat through `send` and `stop`.

import "../../styles/voice.css";
import { IconCamera1 } from "central-icons/IconCamera1";
import { IconCameraOff } from "central-icons/IconCameraOff";
import { IconClosedCaptioning } from "central-icons/IconClosedCaptioning";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconEyeOpen } from "central-icons/IconEyeOpen";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconMicrophoneOff } from "central-icons/IconMicrophoneOff";
import { IconRotate } from "central-icons/IconRotate";
import { IconScreenCapture } from "central-icons/IconScreenCapture";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { messageFromError } from "../../lib/errors";
import { hapticImpact } from "../../lib/haptics";
import { t } from "../../lib/i18n";
import { useModalFocus } from "../../lib/modal-focus";
import type { ReplySnapshot } from "../../lib/voice/reply-snapshot";
import { useVoiceConversation } from "../../lib/voice/use-voice-conversation";
import {
  type CameraFacing,
  cameraPreviewSupported,
  closeCamera,
  frameFromPhoto,
  frameFromVideo,
  openCamera,
} from "../../lib/voice/voice-camera";
import type { VoiceNotice, VoicePhase } from "../../lib/voice/voice-session";
import { voiceCommands } from "../../lib/voice/voice-session";
import { resolveVoiceSpeech } from "../../lib/voice/voice-setup";
import { rememberVoiceIntro, VoiceIntro, voiceIntroSeen } from "./VoiceIntro";
import { ScreenShareIntro, screenIntroSeen } from "./ScreenShareIntro";

/** What goes with a turn besides the words. */
export type VoiceFrame = { kind: "camera"; dataUrl: string } | { kind: "screen"; path: string };

const CAPTIONS_KEY = "subrosa:voice-captions";

function readCaptions(): boolean {
  try {
    return localStorage.getItem(CAPTIONS_KEY) !== "0";
  } catch {
    return true;
  }
}

function phaseLabel(phase: VoicePhase, muted: boolean): string {
  if (muted) return t("Muted");
  switch (phase) {
    case "listening":
      return t("Listening");
    case "transcribing":
      return t("Got it");
    case "thinking":
      return t("Thinking");
    case "speaking":
      return t("Speaking. Talk or tap to interrupt.");
  }
}

function noticeText(notice: VoiceNotice): string {
  switch (notice) {
    case "nothingHeard":
      return t("Nothing was heard. Say it again.");
    case "transcriptionFailed":
      return t("What you said could not be written down. Say it again.");
    case "speechFailed":
      return t("A sentence could not be read aloud. It is in the chat.");
    case "turnFailed":
      return t("Your message could not be sent. Say it again.");
  }
}

type Gate = "checking" | "blocked" | "intro" | "running";

export function VoiceConversation({
  shell,
  reply,
  send,
  stop,
  onClose,
}: {
  shell: "desktop" | "mobile";
  reply: ReplySnapshot;
  /** Sends the words (and a camera or screen frame) as a chat turn. */
  send: (text: string, frame: VoiceFrame | null) => Promise<void>;
  /** Stops the reply being written. */
  stop: () => void;
  onClose: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [gate, setGate] = useState<Gate>("checking");
  const [blockedReason, setBlockedReason] = useState("");
  const [screenAvailable, setScreenAvailable] = useState(false);
  const [captions, setCaptions] = useState(readCaptions);
  const [frameNotice, setFrameNotice] = useState<string | null>(null);

  // The phone's camera: a preview, a facing, and a frame held for the next turn.
  const videoRef = useRef<HTMLVideoElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const cameraRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<CameraFacing>("environment");
  const [heldFrame, setHeldFrame] = useState<string | null>(null);
  const heldFrameRef = useRef<string | null>(null);
  heldFrameRef.current = heldFrame;

  // The Mac's screen: on or off, with its explanation the first time.
  const [screenOn, setScreenOn] = useState(false);
  const screenOnRef = useRef(false);
  screenOnRef.current = screenOn;
  const [screenIntro, setScreenIntro] = useState(false);

  const takeFrame = useCallback(async (): Promise<VoiceFrame | null> => {
    if (shell === "mobile") {
      const dataUrl =
        heldFrameRef.current ?? frameFromVideo(cameraRef.current ? videoRef.current : null);
      setHeldFrame(null);
      return dataUrl ? { kind: "camera", dataUrl } : null;
    }
    if (!screenOnRef.current) return null;
    try {
      return { kind: "screen", path: await voiceCommands.screenFrame() };
    } catch (error) {
      setFrameNotice(messageFromError(error));
      if ((error as { code?: string })?.code === "voice_screen_permission") setScreenOn(false);
      return null;
    }
  }, [shell]);

  const { state, controller } = useVoiceConversation(
    {
      send: async (text) => send(text, await takeFrame()),
      stop,
    },
    reply,
  );

  const begin = useCallback(async () => {
    setGate("running");
    if (shell === "mobile") hapticImpact("light");
    try {
      const speech = await resolveVoiceSpeech();
      if (!speech) {
        setBlockedReason(
          t("No voice can read the replies right now. Choose one in Settings, Personalization."),
        );
        setGate("blocked");
        return;
      }
      await controller.start(speech);
    } catch (error) {
      setBlockedReason(messageFromError(error));
      setGate("blocked");
    }
  }, [controller, shell]);

  useEffect(() => {
    let live = true;
    void voiceCommands
      .availability()
      .then((availability) => {
        if (!live) return;
        setScreenAvailable(availability.screen);
        if (!availability.allowed) {
          setBlockedReason(availability.reason ?? t("Voice conversations are turned off."));
          setGate("blocked");
        } else if (!voiceIntroSeen()) {
          setGate("intro");
        } else {
          void begin();
        }
      })
      .catch((error: unknown) => {
        if (!live) return;
        setBlockedReason(messageFromError(error));
        setGate("blocked");
      });
    return () => {
      live = false;
    };
  }, [begin]);

  const end = useCallback(() => {
    closeCamera(cameraRef.current);
    cameraRef.current = null;
    void controller.end();
    onClose();
  }, [controller, onClose]);

  useModalFocus(surfaceRef, { onClose: end, lockScroll: true });

  // The camera stops with the surface, whatever closed it.
  useEffect(
    () => () => {
      closeCamera(cameraRef.current);
    },
    [],
  );

  useEffect(() => {
    if (videoRef.current && camera) videoRef.current.srcObject = camera;
  }, [camera]);

  async function toggleCamera(nextFacing = facing) {
    if (camera && nextFacing === facing) {
      closeCamera(camera);
      cameraRef.current = null;
      setCamera(null);
      return;
    }
    try {
      closeCamera(cameraRef.current);
      const stream = await openCamera(nextFacing);
      cameraRef.current = stream;
      setFacing(nextFacing);
      setCamera(stream);
    } catch (error) {
      setFrameNotice(t("The camera could not start. Allow it in Settings, then try again."));
      if (import.meta.env.DEV) {
        // biome-ignore lint/suspicious/noConsole: dev-only camera diagnostic
        console.debug("[voice] camera failed", error);
      }
    }
  }

  function look() {
    if (shell !== "mobile") return;
    const frame = frameFromVideo(camera ? videoRef.current : null);
    if (frame) {
      setHeldFrame(frame);
      hapticImpact("light");
      return;
    }
    // No live preview here: one photo from the system camera instead.
    photoInput.current?.click();
  }

  function toggleCaptions() {
    const next = !captions;
    setCaptions(next);
    try {
      localStorage.setItem(CAPTIONS_KEY, next ? "1" : "0");
    } catch {
      // Kept for this surface only.
    }
  }

  function toggleScreen() {
    if (screenOn) {
      setScreenOn(false);
      return;
    }
    if (!screenIntroSeen()) {
      setScreenIntro(true);
      return;
    }
    setScreenOn(true);
  }

  const level = state.phase === "speaking" ? state.output : state.input;
  const orbStyle = { "--voice-level": state.muted ? 0 : level } as CSSProperties;
  const interruptible = state.phase === "speaking" || state.phase === "thinking";
  const notice = frameNotice ?? (state.notice ? noticeText(state.notice) : null);

  // Over the whole window, whatever the composer it was opened from sits in.
  return createPortal(
    <div
      ref={surfaceRef}
      className="voice-surface"
      role="dialog"
      aria-modal="true"
      aria-label={t("Voice conversation")}
      data-shell={shell}
      data-phase={state.phase}
      data-muted={state.muted ? "true" : undefined}
    >
      <header className="voice-header">
        <span className="voice-title">{t("Voice")}</span>
        <button
          type="button"
          className="voice-icon-button"
          aria-label={t("End voice conversation")}
          onClick={end}
        >
          <IconCrossMedium size={18} aria-hidden />
        </button>
      </header>

      {gate === "intro" ? (
        <VoiceIntro
          headphones={shell === "desktop"}
          onCancel={end}
          onStart={() => {
            rememberVoiceIntro();
            void begin();
          }}
        />
      ) : gate === "blocked" || state.status === "error" ? (
        <div className="voice-blocked" role="alert">
          <p>{state.error ?? blockedReason}</p>
          <div className="voice-intro-actions">
            <button type="button" className="voice-secondary" onClick={end}>
              {t("Close")}
            </button>
            {state.status === "error" ? (
              <button type="button" className="voice-primary" onClick={() => void begin()}>
                {t("Try again")}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div className="voice-stage">
            {camera ? (
              <video
                ref={videoRef}
                className="voice-camera"
                autoPlay
                playsInline
                muted
                data-facing={facing}
              />
            ) : null}
            <button
              type="button"
              className="voice-orb"
              style={orbStyle}
              aria-label={interruptible ? t("Interrupt") : phaseLabel(state.phase, state.muted)}
              disabled={!interruptible}
              onClick={() => controller.interrupt()}
            >
              <span className="voice-orb-core" aria-hidden />
            </button>
            <p className="voice-phase" aria-live="polite">
              {state.status === "starting"
                ? t("Opening the microphone…")
                : phaseLabel(state.phase, state.muted)}
            </p>
            {captions ? (
              <div className="voice-captions" aria-live="polite">
                {state.heard ? (
                  <p className="voice-caption" data-role="user">
                    {state.heard}
                  </p>
                ) : null}
                {state.saying ? (
                  <p className="voice-caption" data-role="assistant">
                    {state.saying}
                  </p>
                ) : null}
              </div>
            ) : null}
            {heldFrame ? (
              <div className="voice-held-frame">
                <img src={heldFrame} alt="" />
                <span>{t("This picture goes with what you say next.")}</span>
              </div>
            ) : null}
            {notice ? <p className="voice-notice">{notice}</p> : null}
            {shell === "desktop" && !state.echoCancelled && state.status === "active" ? (
              <p className="voice-hint">{t("Headphones make it easier to talk over a reply.")}</p>
            ) : null}
          </div>

          <footer className="voice-controls">
            <button
              type="button"
              className="voice-control"
              aria-pressed={state.muted}
              aria-label={state.muted ? t("Unmute") : t("Mute")}
              onClick={() => controller.setMuted(!state.muted)}
            >
              {state.muted ? (
                <IconMicrophoneOff size={20} aria-hidden />
              ) : (
                <IconMicrophone size={20} aria-hidden />
              )}
            </button>
            {shell === "mobile" ? (
              <>
                {cameraPreviewSupported() ? (
                  <button
                    type="button"
                    className="voice-control"
                    aria-pressed={camera !== null}
                    aria-label={camera ? t("Turn the camera off") : t("Turn the camera on")}
                    onClick={() => void toggleCamera()}
                  >
                    {camera ? (
                      <IconCameraOff size={20} aria-hidden />
                    ) : (
                      <IconCamera1 size={20} aria-hidden />
                    )}
                  </button>
                ) : null}
                {camera ? (
                  <button
                    type="button"
                    className="voice-control"
                    aria-label={t("Switch camera")}
                    onClick={() =>
                      void toggleCamera(facing === "environment" ? "user" : "environment")
                    }
                  >
                    <IconRotate size={20} aria-hidden />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="voice-control"
                  aria-label={t("Look")}
                  onClick={look}
                >
                  <IconEyeOpen size={20} aria-hidden />
                </button>
                <input
                  ref={photoInput}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    void frameFromPhoto(file)
                      .then(setHeldFrame)
                      .catch(() => setFrameNotice(t("The photo could not be read. Try again.")));
                  }}
                />
              </>
            ) : screenAvailable ? (
              <button
                type="button"
                className="voice-control"
                aria-pressed={screenOn}
                aria-label={screenOn ? t("Stop sharing your screen") : t("Share your screen")}
                onClick={toggleScreen}
              >
                <IconScreenCapture size={20} aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              className="voice-control"
              aria-pressed={captions}
              aria-label={captions ? t("Hide captions") : t("Show captions")}
              onClick={toggleCaptions}
            >
              <IconClosedCaptioning size={20} aria-hidden />
            </button>
            <button type="button" className="voice-end" onClick={end}>
              {t("End")}
            </button>
          </footer>
        </>
      )}
      {screenIntro ? (
        <ScreenShareIntro
          onCancel={() => setScreenIntro(false)}
          onShare={() => {
            setScreenIntro(false);
            setScreenOn(true);
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
