// A conversation with an assistant, on the phone: the Chat tab's thread and
// composer, with the assistant's face and name above it. The conversation is
// the same durable row as on the desktop (`agent_tasks` plus its snapshot);
// this screen only reads it and asks for new turns (ADR-0018).

import "../../../../styles/chat-reading.css";
import { listen } from "@tauri-apps/api/event";
import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconBubblePlus } from "central-icons/IconBubblePlus";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccountSyncUpdated } from "../../../../lib/account-sync-events";
import { type AgentLiteDeltaDto, applyAgentLiteDelta } from "../../../../lib/agent-lite-delta";
import {
  type AssistantDefinition,
  type AssistantTool,
  applyAssistantRevision,
  assistantMediaIds,
  getAssistantChat,
  getAssistantChatDefinition,
  listAssistantChats,
  listAssistants,
  retryAssistantChat,
  sendAssistantChat,
  startAssistantChat,
} from "../../../../lib/assistants";
import { messageFromError } from "../../../../lib/errors";
import { hapticImpact, hapticNotify } from "../../../../lib/haptics";
import { t } from "../../../../lib/i18n";
import { useModalFocus } from "../../../../lib/modal-focus";
import { readableModelName } from "../../../../lib/model-names";
import { SimpleMarkdown } from "../../../../lib/simple-markdown";
import {
  AGENT_LITE_DELTA_EVENT,
  AGENT_LITE_DONE_EVENT,
  AGENT_LITE_STATUS_EVENT,
  type AgentLiteAttachment,
  type AgentLiteStatusDto,
  type AgentTaskDto,
} from "../../../../lib/tauri";
import { AssistantMediaList } from "../../../chat-blocks/AssistantMediaCard";
import { Spinner } from "../../../ui/Spinner";
import { ActionSheet, type SheetAction } from "../../ActionSheet";
import { ChatComposer } from "../../ChatComposer";
import {
  ChatSteps,
  CopyReplyButton,
  hasAttachmentMarkers,
  interruptedAttachmentMessage,
  TypewriterMarkdown,
  withAttachmentMarkers,
} from "../../ChatParts";
import { OptionSheet } from "../../OptionSheet";
import { sheetHost } from "../../sheet-host";
import { StackHeader } from "../../StackHeader";
import { formatNoteTime } from "../NoteRow";
import { AssistantAvatar } from "./AssistantAvatar";

/** Whether the conversation is waiting on a reply the app is producing. */
function awaitingReply(task: AgentTaskDto): boolean {
  return (
    task.messages.at(-1)?.role === "user" && ["queued", "running", "paused"].includes(task.status)
  );
}

type Sheet = "menu" | "history" | "settings" | null;

export function AssistantChatScreen({
  assistantId,
  taskId,
  onBack,
  onEdit,
  onConversationChange,
}: {
  /** Opens a new conversation with this assistant (when there is no task). */
  assistantId?: string;
  /** Opens this conversation. */
  taskId?: string;
  onBack: () => void;
  onEdit: (assistantId: string) => void;
  /** The conversation on screen changed (created, switched, or a new one
   * begun), so the shell can bring it back after a tab switch. */
  onConversationChange?: (taskId: string | null) => void;
}) {
  // The assistant as it is now (header, new conversations), and the version
  // this conversation was started with (what it actually runs on).
  const [assistant, setAssistant] = useState<AssistantDefinition | null>(null);
  const [snapshot, setSnapshot] = useState<AssistantDefinition | null>(null);
  const [task, setTask] = useState<AgentTaskDto | null>(null);
  const [history, setHistory] = useState<AgentTaskDto[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AgentLiteAttachment[]>([]);
  const [streamed, setStreamed] = useState("");
  const [steps, setSteps] = useState<AgentLiteStatusDto[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [animatingId, setAnimatingId] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);

  const activeIdRef = useRef<string | null>(taskId ?? null);
  // Bumped whenever the conversation on screen changes, so an answer to a
  // request made for the previous one is dropped.
  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const retryAttachmentsRef = useRef<AgentLiteAttachment[]>([]);
  const knownIdsRef = useRef<Set<string> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Who this conversation is with. Kept through "new chat", which forgets the
  // conversation's own version of the assistant but not the assistant.
  const ownerId = assistantId ?? snapshot?.id ?? assistant?.id ?? null;
  const shown = snapshot ?? assistant;

  const setBusy = useCallback((value: boolean) => {
    runningRef.current = value;
    setRunning(value);
  }, []);
  const ownerIdRef = useRef(ownerId);
  ownerIdRef.current = ownerId;

  /** What a stored conversation says about the failure it ended on. */
  const settle = useCallback((loaded: AgentTaskDto) => {
    const last = loaded.messages.at(-1);
    const failed = loaded.status === "failed" && last?.role === "user";
    const lost =
      failed && retryAttachmentsRef.current.length === 0 && hasAttachmentMarkers(last.content);
    setCanRetry(failed && !lost);
    setError(
      loaded.status === "failed"
        ? lost
          ? interruptedAttachmentMessage()
          : (loaded.lastError ?? null)
        : null,
    );
  }, []);

  const readTask = useCallback(
    async (id: string) => {
      const epoch = epochRef.current;
      const current = () =>
        mountedRef.current && epochRef.current === epoch && activeIdRef.current === id;
      try {
        const [loaded, definition] = await Promise.all([
          getAssistantChat(id),
          getAssistantChatDefinition(id),
        ]);
        if (!current()) return;
        setTask(loaded);
        setSnapshot(definition);
        setLoadFailed(false);
        const live = awaitingReply(loaded);
        setBusy(live);
        if (!live) {
          setStreamed("");
          setSteps([]);
        }
        settle(loaded);
      } catch (err) {
        if (!current()) return;
        setError(messageFromError(err));
        setLoadFailed(true);
      } finally {
        if (current()) setLoading(false);
      }
    },
    [settle, setBusy],
  );

  const readAssistant = useCallback(async (id: string) => {
    try {
      const found = (await listAssistants()).find((entry) => entry.id === id) ?? null;
      if (mountedRef.current) setAssistant(found);
    } catch {
      // The header falls back to the conversation's own version.
    }
  }, []);

  const readHistory = useCallback(async (id: string) => {
    try {
      const rows = await listAssistantChats(id);
      if (mountedRef.current) setHistory(rows);
    } catch {
      // History is a way back to older conversations, not this one.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (taskId) void readTask(taskId);
  }, [taskId, readTask]);

  useEffect(() => {
    if (!ownerId) return;
    void readAssistant(ownerId);
    void readHistory(ownerId);
  }, [ownerId, readAssistant, readHistory]);

  useEffect(() => {
    const unlistenStatus = listen<AgentLiteStatusDto>(AGENT_LITE_STATUS_EVENT, ({ payload }) => {
      if (!mountedRef.current || payload.taskId !== activeIdRef.current) return;
      setBusy(true);
      setSteps((previous) => {
        const last = previous.at(-1);
        if (last && last.stage === payload.stage && last.detail === payload.detail) return previous;
        return [...previous, payload];
      });
    });
    const unlistenDelta = listen<AgentLiteDeltaDto>(AGENT_LITE_DELTA_EVENT, ({ payload }) => {
      if (!mountedRef.current || payload.taskId !== activeIdRef.current) return;
      setStreamed((current) => applyAgentLiteDelta(current, payload));
    });
    const unlistenDone = listen<AgentTaskDto>(AGENT_LITE_DONE_EVENT, ({ payload }) => {
      if (!mountedRef.current || payload.id !== activeIdRef.current) return;
      setTask(payload);
      setBusy(false);
      setStreamed("");
      setSteps([]);
      setLoading(false);
      settle(payload);
      if (payload.status === "completed") {
        retryAttachmentsRef.current = [];
        hapticNotify("success");
      } else hapticNotify("error");
      if (ownerIdRef.current) void readHistory(ownerIdRef.current);
    });
    return () => {
      void unlistenStatus.then((dispose) => dispose());
      void unlistenDelta.then((dispose) => dispose());
      void unlistenDone.then((dispose) => dispose());
    };
  }, [settle, readHistory, setBusy]);

  // Back from the background, or after another device wrote: the row decides
  // whether a reply is still being written (ADR-0018).
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === "visible" && activeIdRef.current)
        void readTask(activeIdRef.current);
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, [readTask]);
  useAccountSyncUpdated(async () => {
    if (runningRef.current) return;
    if (activeIdRef.current) await readTask(activeIdRef.current);
    if (ownerIdRef.current) await readHistory(ownerIdRef.current);
  });

  // A reply that arrives during this visit types itself out; history that
  // loads with the screen renders at once.
  useEffect(() => {
    if (!task) return;
    if (knownIdsRef.current === null) {
      knownIdsRef.current = new Set(task.messages.map((message) => message.id));
      return;
    }
    const known = knownIdsRef.current;
    const fresh = task.messages.filter((message) => !known.has(message.id));
    for (const message of fresh) known.add(message.id);
    const reply = fresh.filter((message) => message.role === "assistant").at(-1);
    if (reply) setAnimatingId(reply.id);
  }, [task]);

  const scrollToBottom = useCallback(() => {
    if (!pinnedRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows new content while the reader is at the end.
  useEffect(scrollToBottom, [task, streamed, steps, scrollToBottom]);

  const open = useCallback(
    (next: AgentTaskDto | null) => {
      epochRef.current += 1;
      activeIdRef.current = next?.id ?? null;
      knownIdsRef.current = null;
      retryAttachmentsRef.current = [];
      setTask(next);
      setStreamed("");
      setSteps([]);
      setError(null);
      setCanRetry(false);
      setAnimatingId(null);
      setBusy(next ? awaitingReply(next) : false);
      pinnedRef.current = true;
      if (!next) setSnapshot(null);
      onConversationChange?.(next?.id ?? null);
      if (next) {
        setLoading(true);
        void readTask(next.id);
      }
    },
    [onConversationChange, readTask, setBusy],
  );

  const send = async () => {
    const content = draft.trim();
    if ((!content && attachments.length === 0) || runningRef.current || loading) return;
    const id = activeIdRef.current;
    const owner = assistant?.id ?? ownerId;
    if (!id && !owner) return;
    const stored = withAttachmentMarkers(content, attachments);
    const turnAttachments = attachments;
    const submitted = draft;
    retryAttachmentsRef.current = turnAttachments;
    const epoch = ++epochRef.current;
    setDraft("");
    setAttachments([]);
    setError(null);
    setCanRetry(false);
    setStreamed("");
    setSteps([]);
    setBusy(true);
    pinnedRef.current = true;
    hapticImpact("light");
    try {
      const sent = turnAttachments.length ? turnAttachments : undefined;
      const result = id
        ? await sendAssistantChat(id, stored, sent)
        : await startAssistantChat(owner as string, stored, sent);
      if (!mountedRef.current || epochRef.current !== epoch) return;
      activeIdRef.current = result.id;
      setTask(result);
      if (!id) onConversationChange?.(result.id);
      // A reply that finished before the new id reached this screen was
      // announced to nobody: the row has it.
      await readTask(result.id);
    } catch (err) {
      if (!mountedRef.current || epochRef.current !== epoch) return;
      hapticNotify("error");
      setError(messageFromError(err));
      setBusy(false);
      // Nothing was written: the words and the files come back.
      setDraft((current) => (current ? `${submitted}\n${current}` : submitted));
      setAttachments((current) => [...turnAttachments, ...current]);
    }
  };

  const retry = async () => {
    const id = activeIdRef.current;
    if (!id || runningRef.current) return;
    const epoch = ++epochRef.current;
    setError(null);
    setCanRetry(false);
    setStreamed("");
    setSteps([]);
    setBusy(true);
    hapticImpact("light");
    try {
      const turnAttachments = retryAttachmentsRef.current;
      const result = await retryAssistantChat(
        id,
        turnAttachments.length ? turnAttachments : undefined,
      );
      if (!mountedRef.current || epochRef.current !== epoch) return;
      setTask(result);
      await readTask(id);
    } catch (err) {
      if (!mountedRef.current || epochRef.current !== epoch) return;
      setError(messageFromError(err));
      setCanRetry(true);
      setBusy(false);
    }
  };

  const applyRevision = async () => {
    const id = activeIdRef.current;
    if (!id || runningRef.current) return;
    try {
      const result = await applyAssistantRevision(id);
      if (!mountedRef.current || activeIdRef.current !== id) return;
      setTask(result);
      await readTask(id);
      hapticNotify("success");
    } catch (err) {
      if (mountedRef.current) setError(messageFromError(err));
    }
  };

  const name = shown?.name || t("Assistant");
  const opening = shown?.opening_message.trim() ?? "";
  const newerSettings = Boolean(
    task &&
      snapshot &&
      assistant &&
      assistant.revision > snapshot.revision &&
      task.messages.at(-1)?.role !== "user",
  );
  const menu: SheetAction[] = [
    ...(history.length > 0
      ? [{ label: t("Conversations"), onAction: () => setSheet("history") }]
      : []),
    ...(task && snapshot
      ? [{ label: t("Settings for this conversation"), onAction: () => setSheet("settings") }]
      : []),
    ...(newerSettings
      ? [{ label: t("Apply current assistant settings"), onAction: () => void applyRevision() }]
      : []),
    ...(ownerId ? [{ label: t("Edit assistant"), onAction: () => onEdit(ownerId) }] : []),
  ];

  return (
    <div className="mobile-screen-root mobile-chat">
      <StackHeader
        title={name}
        onBack={onBack}
        backLabel={t("Back")}
        titleContent={
          <button
            type="button"
            className="mobile-assistant-chat-title"
            disabled={!ownerId}
            onClick={() => ownerId && onEdit(ownerId)}
          >
            {shown ? <AssistantAvatar assistant={shown} size={28} /> : null}
            <span>{name}</span>
          </button>
        }
        trailing={
          <>
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={t("New chat")}
              disabled={running || !task || !assistant}
              onClick={() => open(null)}
            >
              <IconBubblePlus size={20} />
            </button>
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={t("More")}
              disabled={menu.length === 0}
              onClick={() => setSheet("menu")}
            >
              <IconDotGrid1x3Horizontal size={20} />
            </button>
          </>
        }
      />
      <div
        className="mobile-chat-scroll"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          setShowJump(!pinnedRef.current);
        }}
      >
        {loading ? <Spinner aria-label={t("Loading")} /> : null}
        {!task && !loading && shown ? (
          <div className="mobile-assistant-chat-hero">
            <AssistantAvatar assistant={shown} size={72} />
            <h2>{shown.name}</h2>
            {shown.description ? <p>{shown.description}</p> : null}
          </div>
        ) : null}
        {opening && !loading ? (
          <div className="mobile-chat-bubble" data-role="assistant">
            <SimpleMarkdown text={opening} />
          </div>
        ) : null}
        {task?.messages.map((message) => (
          <div key={message.id} className="mobile-chat-bubble" data-role={message.role}>
            {message.role === "assistant" ? (
              message.id === animatingId ? (
                <TypewriterMarkdown
                  text={message.content}
                  onTick={scrollToBottom}
                  onDone={() => setAnimatingId(null)}
                />
              ) : (
                <>
                  <SimpleMarkdown text={message.content} />
                  <CopyReplyButton text={message.content} />
                </>
              )
            ) : (
              message.content
            )}
          </div>
        ))}
        {running && streamed ? (
          <div className="mobile-chat-bubble" data-role="assistant">
            <SimpleMarkdown text={streamed} streaming />
          </div>
        ) : null}
        {running && !streamed ? <ChatSteps steps={steps} fallback={t("Thinking")} /> : null}
        {task ? (
          <AssistantMediaList
            taskId={task.id}
            excludeIds={assistantMediaIds([
              ...task.messages
                .filter((message) => message.role === "assistant")
                .map((message) => message.content),
              streamed,
            ])}
          />
        ) : null}
        {error ? (
          <div className="mobile-chat-error" role="alert">
            <p className="mobile-dictation-error">{error}</p>
            {loadFailed && activeIdRef.current ? (
              <button
                type="button"
                className="mobile-chat-retry"
                onClick={() => activeIdRef.current && void readTask(activeIdRef.current)}
              >
                {t("Try again")}
              </button>
            ) : canRetry && !running ? (
              <button type="button" className="mobile-chat-retry" onClick={() => void retry()}>
                {t("Try again")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {showJump ? (
        <button
          type="button"
          className="mobile-chat-jump"
          aria-label={t("Jump to latest message")}
          onClick={() => {
            pinnedRef.current = true;
            setShowJump(false);
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: "smooth",
            });
          }}
        >
          <IconArrowDown size={16} />
        </button>
      ) : null}
      <ChatComposer
        draft={draft}
        onDraftChange={setDraft}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        placeholder={t("Message {name}…", { name })}
        canSend={!running && !loading && !loadFailed && Boolean(task || assistant)}
        onSend={() => void send()}
        onError={setError}
        inputRef={inputRef}
      />
      {sheet === "menu" ? (
        <ActionSheet
          title={name}
          actions={menu}
          // The sheet closes itself after an action; an action that opened
          // the next sheet keeps it.
          onClose={() => setSheet((current) => (current === "menu" ? null : current))}
        />
      ) : null}
      {sheet === "history" ? (
        <OptionSheet
          title={t("Conversations with {name}", { name })}
          options={[
            { value: "", label: t("New chat") },
            ...history.map((entry) => ({
              value: entry.id,
              label: `${entry.title.trim() || entry.prompt.trim() || t("Conversation")} · ${formatNoteTime(entry.updatedAt)}`,
            })),
          ]}
          selected={task?.id ?? ""}
          onSelect={(value) => {
            setSheet(null);
            if (value === (task?.id ?? "")) return;
            open(history.find((entry) => entry.id === value) ?? null);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "settings" && snapshot ? (
        <ConversationSettingsSheet definition={snapshot} onClose={() => setSheet(null)} />
      ) : null}
    </div>
  );
}

/** What this conversation runs on: the assistant as it was when it began. */
function ConversationSettingsSheet({
  definition,
  onClose,
}: {
  definition: AssistantDefinition;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(sheetRef, { onClose });
  const title = t("Settings for this conversation");
  return createPortal(
    <div className="mobile-sheet-backdrop">
      <button
        type="button"
        className="mobile-sheet-dismiss"
        aria-label={t("Close")}
        onClick={onClose}
      />
      <div
        className="mobile-sheet mobile-action-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        tabIndex={-1}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <p className="mobile-sheet-title">{title}</p>
        <p className="mobile-action-sheet-subtitle">
          {t("This conversation uses version {revision} of {name}.", {
            revision: definition.revision,
            name: definition.name,
          })}
        </p>
        <dl className="mobile-assistant-settings">
          <div>
            <dt>{t("Model")}</dt>
            <dd>{definition.model ? readableModelName(definition.model) : t("Default")}</dd>
          </div>
          <div>
            <dt>{t("Tools")}</dt>
            <dd>
              {definition.tools.length ? definition.tools.map(toolLabel).join(", ") : t("None")}
            </dd>
          </div>
          <div>
            <dt>{t("Access my notes")}</dt>
            <dd>{definition.allow_notes ? t("Enabled") : t("Disabled")}</dd>
          </div>
          <div>
            <dt>{t("Use my personal memory")}</dt>
            <dd>{definition.allow_memory ? t("Enabled") : t("Disabled")}</dd>
          </div>
          {definition.instructions.trim() ? (
            <div className="mobile-assistant-settings-instructions">
              <dt>{t("Instructions")}</dt>
              <dd>{definition.instructions}</dd>
            </div>
          ) : null}
        </dl>
        <button type="button" className="mobile-action-sheet-cancel" onClick={onClose}>
          {t("OK")}
        </button>
      </div>
    </div>,
    sheetHost(),
  );
}

export function toolLabel(tool: AssistantTool): string {
  switch (tool) {
    case "web":
      return t("Web search");
    case "image":
      return t("Images");
    case "video":
      return t("Video");
    case "music":
      return t("Music");
    case "speech":
      return t("Speech");
  }
}
