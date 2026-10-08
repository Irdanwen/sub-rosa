import { useEffect, useRef, useState } from "react";
import { number, t } from "../../lib/i18n";
import { speech } from "../carpe-diem";
import type { ComposerControlProps, FeatureHost } from "../feature";
import { speechVoice } from "../models";
import { voiceRefusal } from "../protected/rules";
import { type Microphone, openMicrophone, WebAudioPlayer } from "./audio";
import {
  canShareScreen,
  canUseCamera,
  frameFromVideo,
  openCamera,
  openScreen,
  stopStream,
} from "./frames";
import { fenceLabel, noticeLabel, phaseLabel } from "./labels";
import type { Phase } from "./machine";
import { creditsPerMinute, priceList, transcriptionModel } from "./routing";
import { SAMPLE_RATE, type VoiceEvent, VoiceSession } from "./session";
import { transcribe } from "./transcribe";
import "./voice.css";

const PRICE_SAID = "price-said";

type Stage =
  | { kind: "idle" }
  | { kind: "price"; credits: number | null }
  | { kind: "starting" }
  | { kind: "active" };

/** The price before the first conversation (ADR-0093 decision 9). */
async function priceOf(host: FeatureHost): Promise<number | null> {
  const prices = await priceList(host.operator);
  return creditsPerMinute(prices, speechVoice(host.live).model, transcriptionModel(host.live));
}

/**
 * "Voice" beside the composer: a spoken conversation in the open chat, each
 * turn an ordinary turn of that chat, with the camera or a shared screen
 * riding the turn as a picture when the person turns one on.
 */
export function VoiceControl({ host, chatId, temporary }: ComposerControlProps) {
  const hostRef = useRef(host);
  hostRef.current = host;
  const chatRef = useRef<string | null>(chatId);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [phase, setPhase] = useState<Phase>("listening");
  const [heard, setHeard] = useState("");
  const [saying, setSaying] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const [screen, setScreen] = useState<MediaStream | null>(null);
  const session = useRef<VoiceSession | null>(null);
  const microphone = useRef<Microphone | null>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const screenVideo = useRef<HTMLVideoElement>(null);
  const looked = useRef<string | null>(null);
  const streams = useRef<{ camera: MediaStream | null; screen: MediaStream | null }>({
    camera: null,
    screen: null,
  });
  streams.current = { camera, screen };

  useEffect(() => {
    if (preview.current) preview.current.srcObject = camera;
  }, [camera]);
  useEffect(() => {
    if (screenVideo.current) screenVideo.current.srcObject = screen;
  }, [screen]);

  // Leaving the chat (or the page) ends the conversation.
  useEffect(
    () => () => {
      session.current?.end();
      microphone.current?.stop();
      stopStream(streams.current.camera);
      stopStream(streams.current.screen);
    },
    [],
  );

  const closeDevices = () => {
    microphone.current?.stop();
    microphone.current = null;
    session.current = null;
    setCamera((stream) => {
      stopStream(stream);
      return null;
    });
    setScreen((stream) => {
      stopStream(stream);
      return null;
    });
  };

  /** The picture this turn carries: a "Look" frame, else the camera now,
   * else one frame of the shared screen. */
  const pictures = (): string[] => {
    const frame =
      looked.current ?? frameFromVideo(preview.current) ?? frameFromVideo(screenVideo.current);
    looked.current = null;
    return frame ? [frame] : [];
  };

  const start = async () => {
    setError("");
    const refusal = voiceRefusal(host.guards);
    if (refusal) {
      setError(refusal);
      return;
    }
    if (!(await host.openKey().catch(() => null))) {
      setError(
        t(
          "This browser has no Carpe Diem key yet. Get one from your devices page.",
          "Ce navigateur n’a pas encore de clé Carpe Diem. Obtenez-en une depuis la page de vos appareils.",
        ),
      );
      return;
    }
    const store = host.storeFor("voice");
    if (stage.kind !== "price" && !(await store.get<boolean>(PRICE_SAID))) {
      setStage({ kind: "price", credits: await priceOf(host) });
      return;
    }
    await store.put(PRICE_SAID, true);
    setStage({ kind: "starting" });
    chatRef.current = chatId;
    setHeard("");
    setSaying("");
    setNotice("");
    try {
      let live: VoiceSession | null = null;
      const mic = await openMicrophone((samples) => live?.pushAudio(samples));
      microphone.current = mic;
      const player = new WebAudioPlayer(mic.context);
      const key = async () => {
        const opened = await hostRef.current.openKey();
        if (!opened) throw new Error("no key");
        return opened;
      };
      live = new VoiceSession({
        transcribe: async (samples, signal) =>
          transcribe(
            hostRef.current.operator,
            await key(),
            samples,
            SAMPLE_RATE,
            transcriptionModel(hostRef.current.live),
            signal,
          ),
        sendTurn: async (text, onReply, signal) => {
          const current = hostRef.current;
          // A frame rides the turn as a photo does: the page moves it to a
          // model as private that can see, or refuses it (`attachments.ts`).
          let soFar = "";
          const result = await current.ask(text, {
            chatId: chatRef.current,
            images: pictures(),
            signal,
            onText: (fragment) => {
              soFar += fragment;
              onReply(soFar);
            },
          });
          chatRef.current = result.chatId;
          return soFar || result.answer;
        },
        render: async (text, signal) =>
          speech(
            hostRef.current.operator,
            await key(),
            text,
            speechVoice(hostRef.current.live),
            signal,
          ),
        player,
        refusal: () => voiceRefusal(hostRef.current.guards),
        fenceLabel,
        onEvent: (event: VoiceEvent) => {
          if (event.kind === "phase") setPhase(event.phase);
          else if (event.kind === "heard") setHeard(event.text);
          else if (event.kind === "saying") setSaying(event.text);
          else if (event.kind === "notice") setNotice(noticeLabel(event.notice));
          else if (event.kind === "ended") {
            closeDevices();
            setStage({ kind: "idle" });
            if (event.reason) setError(event.reason);
          }
        },
      });
      session.current = live;
      setMuted(false);
      setPhase("listening");
      setStage({ kind: "active" });
    } catch {
      closeDevices();
      setStage({ kind: "idle" });
      setError(
        t(
          "The microphone could not start. Allow it for this site, then try again.",
          "Le micro n’a pas pu démarrer. Autorisez-le pour ce site, puis réessayez.",
        ),
      );
    }
  };

  const toggleCamera = async () => {
    if (camera) {
      stopStream(camera);
      setCamera(null);
      return;
    }
    try {
      stopStream(screen);
      setScreen(null);
      setCamera(await openCamera());
    } catch {
      setNotice(t("The camera could not start.", "La caméra n’a pas pu démarrer."));
    }
  };

  const toggleScreen = async () => {
    if (screen) {
      stopStream(screen);
      setScreen(null);
      return;
    }
    try {
      stopStream(camera);
      setCamera(null);
      const stream = await openScreen();
      // The browser's own "Stop sharing" ends it here too.
      for (const track of stream.getVideoTracks())
        track.addEventListener("ended", () => setScreen(null), { once: true });
      setScreen(stream);
    } catch {
      setNotice(t("The screen was not shared.", "L’écran n’a pas été partagé."));
    }
  };

  if (temporary) return null;

  if (stage.kind !== "active")
    return (
      <div className="wc-voice">
        {stage.kind === "price" ? (
          <div className="wc-voice-price" role="dialog" aria-label={t("Voice", "Voix")}>
            <p>
              {stage.credits !== null
                ? t(
                    `A minute of conversation costs about ${number(stage.credits)} credits to hear and speak, plus the replies themselves, priced like typed ones.`,
                    `Une minute de conversation coûte environ ${number(stage.credits)} crédits pour écouter et parler, plus les réponses elles-mêmes, au prix des réponses écrites.`,
                  )
                : t(
                    "A conversation is billed as transcription, by the second you speak, and as speech, by the character read, plus the replies themselves, priced like typed ones.",
                    "Une conversation est facturée en transcription, à la seconde parlée, et en voix, au caractère lu, plus les réponses elles-mêmes, au prix des réponses écrites.",
                  )}
            </p>
            <div className="wc-row">
              <button className="button primary" type="button" onClick={() => void start()}>
                {t("Start talking", "Commencer à parler")}
              </button>
              <button className="button" type="button" onClick={() => setStage({ kind: "idle" })}>
                {t("Cancel", "Annuler")}
              </button>
            </div>
          </div>
        ) : (
          <button
            className="button"
            type="button"
            disabled={stage.kind === "starting"}
            onClick={() => void start()}
          >
            {t("Voice", "Voix")}
          </button>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );

  const replying = phase === "thinking" || phase === "speaking";
  return (
    <section
      className="wc-voice wc-voice-active"
      aria-label={t("Voice conversation", "Conversation vocale")}
    >
      <p className="wc-voice-phase" role="status">
        {muted ? t("Muted", "Micro coupé") : phaseLabel(phase)}
      </p>
      {heard && (
        <p className="wc-voice-caption">
          <strong>{t("You", "Vous")}:</strong> {heard}
        </p>
      )}
      {saying && (
        <p className="wc-voice-caption">
          <strong>Sub Rosa:</strong> {saying}
        </p>
      )}
      {camera && <video ref={preview} className="wc-voice-preview" autoPlay muted playsInline />}
      {screen && (
        <video ref={screenVideo} className="wc-voice-preview" autoPlay muted playsInline />
      )}
      <div className="wc-row">
        {replying && (
          <button className="button" type="button" onClick={() => session.current?.interrupt()}>
            {t("Stop the reply", "Arrêter la réponse")}
          </button>
        )}
        <button
          className="button"
          type="button"
          aria-pressed={muted}
          onClick={() => {
            session.current?.setMuted(!muted);
            setMuted(!muted);
          }}
        >
          {muted ? t("Unmute", "Réactiver le micro") : t("Mute", "Couper le micro")}
        </button>
        {canUseCamera() && (
          <button
            className="button"
            type="button"
            aria-pressed={!!camera}
            onClick={() => void toggleCamera()}
          >
            {camera ? t("Camera off", "Couper la caméra") : t("Camera", "Caméra")}
          </button>
        )}
        {camera && (
          <button
            className="button"
            type="button"
            onClick={() => {
              looked.current = frameFromVideo(preview.current);
              setNotice(
                t(
                  "Got it: the picture goes with what you say next.",
                  "C’est noté : l’image part avec ce que vous direz ensuite.",
                ),
              );
            }}
          >
            {t("Look", "Regarder")}
          </button>
        )}
        {canShareScreen() && (
          <button
            className="button"
            type="button"
            aria-pressed={!!screen}
            onClick={() => void toggleScreen()}
          >
            {screen
              ? t("Stop sharing", "Arrêter le partage")
              : t("Share screen", "Partager l’écran")}
          </button>
        )}
        <button className="button primary" type="button" onClick={() => session.current?.end()}>
          {t("End", "Terminer")}
        </button>
      </div>
      <p className="quiet">
        {camera || screen
          ? t(
              "One picture goes with each thing you say, nothing in between.",
              "Une image part avec chaque chose que vous dites, rien entre les deux.",
            )
          : t(
              "Headphones keep the reply out of the microphone, so you can talk over it.",
              "Un casque garde la réponse hors du micro, pour que vous puissiez parler par-dessus.",
            )}
      </p>
      {notice && <p className="quiet">{notice}</p>}
    </section>
  );
}
