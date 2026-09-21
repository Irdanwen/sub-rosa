import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AssistantMediaList } from "../chat-blocks/AssistantMediaCard";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AssistantDefinition,
  getAssistantChat,
  retryAssistantChat,
  applyAssistantRevision,
  assistantMediaIds,
  listAssistantChats,
  sendAssistantChat,
  startAssistantChat,
} from "../../lib/assistants";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { SimpleMarkdown } from "../../lib/simple-markdown";
import {
  AGENT_LITE_DELTA_EVENT,
  AGENT_LITE_DONE_EVENT,
  AGENT_LITE_STATUS_EVENT,
  type AgentLiteStatusDto,
  type AgentTaskDto,
} from "../../lib/tauri";
import { BrandMark } from "../brand/Marks";

const isRunning = (task: AgentTaskDto) => ["queued", "running", "paused"].includes(task.status);

/** The same native, persisted conversation on both shells. Rendering does not execute tools. */
export function AssistantChat({
  assistant,
  initialTask,
}: {
  assistant: AssistantDefinition;
  initialTask?: AgentTaskDto;
}) {
  const [task, setTask] = useState<AgentTaskDto | null>(initialTask ?? null);
  const [history, setHistory] = useState<AgentTaskDto[]>([]);
  const [content, setContent] = useState("");
  const [stream, setStream] = useState("");
  const [busy, setBusy] = useState(initialTask ? isRunning(initialTask) : false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<(AgentLiteStatusDto & { key: string })[]>([]);
  const activeId = useRef<string | null>(initialTask?.id ?? null);
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const alive = useRef(true);
  const sending = useRef(false);
  const version = useRef(0);
  const historyRequest = useRef(0);
  const taskRequest = useRef(0);
  const isCurrent = useCallback(
    (id: string | null, epoch: number) =>
      alive.current && activeId.current === id && version.current === epoch,
    [],
  );
  const refreshHistory = useCallback(async () => {
    const id = activeId.current;
    const epoch = version.current;
    const request = ++historyRequest.current;
    try {
      const rows = await listAssistantChats(assistant.id);
      if (isCurrent(id, epoch) && request === historyRequest.current) setHistory(rows);
    } catch (err) {
      if (isCurrent(id, epoch) && request === historyRequest.current)
        setError(messageFromError(err));
    }
  }, [assistant.id, isCurrent]);
  const readTask = useCallback(
    async (id: string) => {
      const epoch = version.current;
      const request = ++taskRequest.current;
      try {
        const loaded = await getAssistantChat(id);
        if (!isCurrent(id, epoch) || request !== taskRequest.current || loaded.id !== id) return;
        setTask(loaded);
        setBusy(isRunning(loaded));
        if (!isRunning(loaded)) setStream("");
        setError(loaded.lastError ?? null);
      } catch (err) {
        if (isCurrent(id, epoch) && request === taskRequest.current)
          setError(messageFromError(err));
      }
    },
    [isCurrent],
  );
  useEffect(() => {
    alive.current = true;
    const unsubscribers: (() => void)[] = [];
    let disposed = false;
    async function subscribe() {
      try {
        const listeners = await Promise.all([
          listen<{ taskId: string; text: string }>(AGENT_LITE_DELTA_EVENT, ({ payload }) => {
            if (!disposed && alive.current && payload.taskId === activeId.current)
              setStream((previous) => previous + payload.text);
          }),
          listen<AgentLiteStatusDto>(AGENT_LITE_STATUS_EVENT, ({ payload }) => {
            if (!disposed && alive.current && payload.taskId === activeId.current)
              setSteps((previous) => [...previous, { ...payload, key: crypto.randomUUID() }]);
          }),
          listen<AgentTaskDto>(AGENT_LITE_DONE_EVENT, ({ payload }) => {
            if (disposed || !alive.current || payload.id !== activeId.current) return;
            version.current += 1;
            setTask(payload);
            setBusy(false);
            setStream("");
            setError(payload.lastError ?? null);
            void refreshHistory().catch(() => undefined);
          }),
        ]);
        if (disposed) {
          for (const dispose of listeners) dispose();
          return;
        }
        unsubscribers.push(...listeners);
        setReady(true);
        if (activeId.current) await readTask(activeId.current);
      } catch (err) {
        if (!disposed && alive.current) setError(messageFromError(err));
      }
    }
    void subscribe();
    void refreshHistory();
    return () => {
      disposed = true;
      alive.current = false;
      version.current += 1;
      for (const dispose of unsubscribers) dispose();
    };
  }, [refreshHistory, readTask]);
  useEffect(() => {
    if ((task || stream || steps.length > 0) && pinned.current)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [task, stream, steps]);
  // Read only on resume. Native durable rows decide whether work is still live.
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== "visible" || !activeId.current) return;
      void readTask(activeId.current);
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, [readTask]);

  async function send() {
    if (busy || sending.current || !ready || !content.trim()) return;
    sending.current = true;
    const message = content.trim();
    const originalContent = content;
    const id = activeId.current;
    const epoch = ++version.current;
    setContent("");
    setBusy(true);
    setError(null);
    setSteps([]);
    setStream("");
    pinned.current = true;
    try {
      const result = id
        ? await sendAssistantChat(id, message)
        : await startAssistantChat(assistant.id, message);
      if (!isCurrent(id, epoch)) return;
      activeId.current = result.id;
      setTask(result);
      setBusy(isRunning(result));
      setError(result.lastError ?? null);
      // Reconcile a completion emitted before a newly-created task ID reached us.
      await readTask(result.id);
      if (isCurrent(result.id, epoch)) await refreshHistory();
    } catch (err) {
      if (isCurrent(id, epoch)) {
        setError(messageFromError(err));
        setContent((current) => current || originalContent);
        setBusy(false);
      }
    } finally {
      sending.current = false;
    }
  }

  async function updateConversation(action: "retry" | "revision") {
    const id = activeId.current;
    if (!id || busy || sending.current) return;
    sending.current = true;
    const epoch = ++version.current;
    setBusy(true);
    setError(null);
    if (action === "retry") {
      setStream("");
      setSteps([]);
    }
    try {
      const result = await (action === "retry"
        ? retryAssistantChat(id)
        : applyAssistantRevision(id));
      if (!isCurrent(id, epoch) || result.id !== id) return;
      setTask(result);
      setBusy(isRunning(result));
      setError(result.lastError ?? null);
      await readTask(id);
    } catch (err) {
      if (isCurrent(id, epoch)) {
        setError(messageFromError(err));
        setBusy(false);
      }
    } finally {
      sending.current = false;
    }
  }

  return (
    <section
      className="assistant-chat"
      aria-label={t("Conversation with {name}", { name: assistant.name })}
    >
      <header className="assistant-chat-header">
        <strong>{assistant.name}</strong>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => {
            version.current += 1;
            activeId.current = null;
            setTask(null);
            setStream("");
            setSteps([]);
            setError(null);
          }}
        >
          {t("New chat")}
        </button>
      </header>
      {history.length > 0 && (
        <label className="assistant-field assistant-history">
          <span>{t("Chat history")}</span>
          <select
            value={task?.id ?? ""}
            disabled={busy}
            onChange={(event) => {
              const selected = history.find((entry) => entry.id === event.target.value);
              if (selected) {
                version.current += 1;
                activeId.current = selected.id;
                setTask(selected);
                setBusy(isRunning(selected));
                setError(selected.lastError ?? null);
                setSteps([]);
                setStream("");
                void readTask(selected.id);
              }
            }}
          >
            <option value="">{t("New chat")}</option>
            {history.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title || entry.prompt}
              </option>
            ))}
          </select>
        </label>
      )}
      <div
        className="assistant-chat-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {!task && (
          <div className="assistant-chat-welcome">
            <BrandMark />
            <h2>{assistant.name}</h2>
            <p>{assistant.opening_message || assistant.description}</p>
          </div>
        )}
        {task?.messages.map((message) => (
          <div className="assistant-message" data-role={message.role} key={message.id}>
            {message.role === "assistant" ? (
              <>
                <SimpleMarkdown text={message.content} />
                <CopyAssistantReply content={message.content} />
              </>
            ) : (
              message.content
            )}
          </div>
        ))}
        {steps.length > 0 && (
          <details className="assistant-activity">
            <summary>
              {busy ? t("Working") : t("Activity")} · {steps.length}
            </summary>
            <ul>
              {steps.map((step) => (
                <li key={step.key}>{step.detail || activityLabel(step.stage)}</li>
              ))}
            </ul>
          </details>
        )}
        {busy && stream && (
          <div className="assistant-message" data-role="assistant">
            <SimpleMarkdown text={stream} streaming />
          </div>
        )}
        {busy && !stream && (
          <p role="status" className="assistant-muted">
            {t("Working")}
          </p>
        )}
        {task && (
          <AssistantMediaList
            taskId={task.id}
            excludeIds={assistantMediaIds([
              ...task.messages
                .filter((message) => message.role === "assistant")
                .map((message) => message.content),
              stream,
            ])}
          />
        )}
        {error && (
          <p className="assistant-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {task && !busy && (
        <div className="assistant-actions assistant-history">
          {task.status === "failed" && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void updateConversation("retry")}
            >
              {t("Try again")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={task.messages.at(-1)?.role === "user"}
            onClick={() => void updateConversation("revision")}
          >
            {t("Apply current assistant settings")}
          </button>
        </div>
      )}
      <form
        className="assistant-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={t("Write your message…")}
          aria-label={t("Your message")}
          rows={3}
          disabled={!ready}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !ready || !content.trim()}
        >
          {t("Send")}
        </button>
      </form>
    </section>
  );
}

function activityLabel(stage: AgentLiteStatusDto["stage"]) {
  switch (stage) {
    case "thinking":
      return t("Thinking");
    case "searching-notes":
      return t("Searching your notes");
    case "searching-web":
      return t("Searching the web");
    case "searching-memory":
      return t("Searching your memory");
    case "reading-note":
      return t("Reading a note");
    default:
      return t("Working");
  }
}

function CopyAssistantReply({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="assistant-reply-actions">
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => {
          void writeText(content)
            .then(() => {
              setCopied(true);
              setError(null);
            })
            .catch((err) => setError(messageFromError(err)));
        }}
      >
        {copied ? t("Copied") : t("Copy")}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
