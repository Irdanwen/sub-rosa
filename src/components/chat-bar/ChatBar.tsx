import { t } from "../../lib/i18n";
import { listen } from "@tauri-apps/api/event";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconEyeOpen } from "central-icons/IconEyeOpen";
import { IconPlusSmall } from "central-icons/IconPlusSmall";
import { IconScreenCapture } from "central-icons/IconScreenCapture";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CHAT_BAR_OPENED_EVENT,
  IDLE_TURN,
  type ChatBarTurn,
  applyChatBarEvent,
  chatBarEventEnds,
  chatBarHide,
  chatBarOpenInApp,
  chatBarSetHeight,
  chatTitleFor,
  promptWithFiles,
} from "../../lib/chat-bar";
import { messageFromError } from "../../lib/errors";
import { classifyHermesEvent } from "../../lib/hermes-control-plane/event-classifier";
import { hermesConnectionForMode } from "../../lib/hermes-connection";
import { HermesGatewayClient, type HermesSessionCreateResponse } from "../../lib/hermes-gateway";
import {
  type LookingAt,
  type ScreenAwarenessSettings,
  captureLookingAt,
  lookingAtPaths,
  screenAwarenessSettings,
} from "../../lib/screen-awareness";
import { SimpleMarkdown } from "../../lib/simple-markdown";
import { hermesBridgeStatus, importHermesBridgeFile, startHermesBridge } from "../../lib/tauri";
import {
  AgentBrowserConsentCard,
  useAgentBrowserStatus,
} from "../agent-browser/AgentBrowserIndicator";
import { LookingAtChip } from "./LookingAtChip";

type ChatSession = { storedId: string; runtimeId: string; title: string };

/** The gateway of the sandboxed runtime, started when nothing is running. */
async function connectGateway(client: HermesGatewayClient) {
  let connection = hermesConnectionForMode(await hermesBridgeStatus(), false);
  if (!connection) {
    connection = hermesConnectionForMode(await startHermesBridge({ fullMode: false }), false);
  }
  if (!connection?.wsUrl) {
    throw new Error(t("The agent could not start. Open Sub Rosa and try again."));
  }
  await client.connect(connection.wsUrl);
}

/**
 * The chat bar's panel (ADR-0094): one field, Enter asks, the answer streams
 * in, Esc closes, "Open in Sub Rosa" carries the chat to the main window.
 * Follow-ups in the same panel continue the same chat; "New chat" starts
 * another.
 */
export function ChatBar() {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<HermesGatewayClient | null>(null);
  const sessionRef = useRef<ChatSession | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const [draft, setDraft] = useState("");
  const [question, setQuestion] = useState("");
  const [turn, setTurn] = useState<ChatBarTurn>(IDLE_TURN);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [awareness, setAwareness] = useState<ScreenAwarenessSettings | null>(null);
  const [lookingAt, setLookingAt] = useState<LookingAt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const browser = useAgentBrowserStatus();

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      Promise.resolve()
        .then(() => screenAwarenessSettings())
        .then((next) => setAwareness(next ?? null))
        .catch(() => setAwareness(null));
    };
    focus();
    const unlisten = listen(CHAT_BAR_OPENED_EVENT, focus).catch(() => undefined);
    return () => {
      void unlisten.then((stop) => stop?.());
      unsubscribeRef.current?.();
      clientRef.current?.close();
    };
  }, []);

  // The native panel follows the content's height.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      void chatBarSetHeight(Math.ceil(root.getBoundingClientRect().height)).catch(() => {});
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const busy = turn.phase === "sending" || turn.phase === "streaming";

  async function attachLookingAt(screenshot: boolean) {
    setCapturing(true);
    setNotice(null);
    try {
      setLookingAt(await captureLookingAt(screenshot));
    } catch (err) {
      setNotice(messageFromError(err));
    } finally {
      setCapturing(false);
      inputRef.current?.focus();
    }
  }

  async function ensureSession(client: HermesGatewayClient, text: string) {
    if (sessionRef.current) return sessionRef.current;
    const title = chatTitleFor(text);
    const created = await client.request<HermesSessionCreateResponse>("session.create", {
      title,
      cols: 96,
    });
    const runtimeId = String(created.session_id ?? created.id ?? "");
    const storedId = String(created.stored_session_id ?? runtimeId);
    if (!runtimeId) throw new Error(t("Hermes did not create a session."));
    const next = { storedId, runtimeId, title };
    sessionRef.current = next;
    setSession(next);
    return next;
  }

  async function send() {
    const text = draft.trim();
    if ((!text && !lookingAt) || busy) return;
    setNotice(null);
    setQuestion(text);
    setTurn({ ...IDLE_TURN, phase: "sending" });
    try {
      const client = clientRef.current ?? new HermesGatewayClient();
      clientRef.current = client;
      await connectGateway(client);
      const files = lookingAt
        ? await Promise.all(lookingAtPaths(lookingAt).map((path) => importHermesBridgeFile(path)))
        : [];
      const current = await ensureSession(client, text || t("What I’m looking at"));
      unsubscribeRef.current?.();
      const stop = client.onEvent((raw) => {
        const event = classifyHermesEvent(raw);
        setTurn((previous) => applyChatBarEvent(previous, event, current.runtimeId));
        if (chatBarEventEnds(event, current.runtimeId)) stop();
      });
      unsubscribeRef.current = () => {
        stop();
      };
      await client.request("prompt.submit", {
        session_id: current.runtimeId,
        text: promptWithFiles(text, files),
      });
      setDraft("");
      setLookingAt(null);
    } catch (err) {
      setTurn({ ...IDLE_TURN, phase: "error", error: messageFromError(err) });
    }
  }

  function newChat() {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    sessionRef.current = null;
    setSession(null);
    setTurn(IDLE_TURN);
    setQuestion("");
    setLookingAt(null);
    inputRef.current?.focus();
  }

  function openInApp() {
    const current = sessionRef.current;
    void chatBarOpenInApp(current ? { id: current.storedId, title: current.title } : undefined);
  }

  return (
    <div className="chat-bar" ref={rootRef}>
      <form
        className="chat-bar-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={inputRef}
          className="chat-bar-input"
          rows={1}
          value={draft}
          placeholder={session ? t("Ask a follow-up") : t("Ask Sub Rosa")}
          aria-label={t("Ask Sub Rosa")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              void chatBarHide();
            } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {awareness?.enabled ? (
          <button
            type="button"
            className="chat-bar-icon-button"
            aria-label={t("Add what I’m looking at")}
            title={t("Add what I’m looking at")}
            disabled={capturing}
            onClick={() => void attachLookingAt(false)}
          >
            <IconEyeOpen size={16} aria-hidden />
          </button>
        ) : null}
        {awareness?.enabled && awareness.screenshots ? (
          <button
            type="button"
            className="chat-bar-icon-button"
            aria-label={t("Add a picture of the window")}
            title={t("Add a picture of the window")}
            disabled={capturing}
            onClick={() => void attachLookingAt(true)}
          >
            <IconScreenCapture size={16} aria-hidden />
          </button>
        ) : null}
        <button
          type="submit"
          className="chat-bar-send"
          aria-label={t("Send message")}
          disabled={busy || (!draft.trim() && !lookingAt)}
        >
          <IconArrowUp size={16} aria-hidden />
        </button>
      </form>

      {lookingAt ? <LookingAtChip value={lookingAt} onRemove={() => setLookingAt(null)} /> : null}
      {notice ? (
        <p className="chat-bar-error" role="alert">
          {notice}
        </p>
      ) : null}
      {browser?.pending.map((pending) => (
        <AgentBrowserConsentCard key={pending.id} pending={pending} />
      ))}

      {turn.phase !== "idle" ? (
        <section className="chat-bar-answer" aria-live="polite">
          {question ? <p className="chat-bar-question">{question}</p> : null}
          {turn.answer ? (
            <SimpleMarkdown text={turn.answer} streaming={turn.phase === "streaming"} />
          ) : turn.phase === "sending" || turn.phase === "streaming" ? (
            <p className="chat-bar-thinking">{t("Thinking…")}</p>
          ) : null}
          {turn.phase === "error" && turn.error ? (
            <p className="chat-bar-error" role="alert">
              {turn.error}
            </p>
          ) : null}
          {turn.needsApp ? (
            <p className="chat-bar-notice">
              {t("Sub Rosa needs your answer to go on. Open the chat to reply.")}
            </p>
          ) : null}
          <div className="chat-bar-actions">
            <button type="button" className="btn btn-ghost" onClick={newChat}>
              <IconPlusSmall size={14} aria-hidden />
              {t("New chat")}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!session}
              onClick={openInApp}
            >
              <IconArrowUpRight size={14} aria-hidden />
              {t("Open in Sub Rosa")}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
