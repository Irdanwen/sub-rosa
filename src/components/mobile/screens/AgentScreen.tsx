import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconClock } from "central-icons/IconClock";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconPaperclip1 } from "central-icons/IconPaperclip1";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { chatBlocksToClipboardText } from "../../../lib/chat-blocks";
import { friendlyErrorMessage, messageFromError } from "../../../lib/errors";
import { hapticImpact, hapticNotify, hapticSelection } from "../../../lib/haptics";
import { useKeyboardInset } from "../../../lib/keyboard-inset";
import { SimpleMarkdown } from "../../../lib/simple-markdown";
import { fetchMediaCatalog, formatCredits, modelsOfType } from "../../../lib/studio/catalog";
import { ensureNotificationPermission } from "../../../lib/notifications";
import { resolveTurnModel } from "../../../lib/vision-routing";
import type { MediaModel } from "../../../lib/studio/types";
import {
  AGENT_LITE_DELTA_EVENT,
  AGENT_LITE_DONE_EVENT,
  AGENT_LITE_STATUS_EVENT,
  type AgentLiteAttachment,
  type AgentLiteStatusDto,
  type AgentTaskDto,
  agentLiteRun,
  assignSessionToFolder,
  createAgentTask,
  deleteAgentTask,
  forkAgentTask,
  getAgentTask,
  listAgentTasks,
  listSessionFolders,
  mobileDictationStart,
  mobileDictationStop,
  removeSessionFromFolder,
  sendAgentMessage,
  setAgentTaskModel,
  suggestAgentSessionTitle,
} from "../../../lib/tauri";
import { BrandGradientMark } from "../../brand/Marks";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { EmptyState } from "../../ui/EmptyState";
import { Spinner } from "../../ui/Spinner";
import { ModelSheet } from "../ModelSheet";
import { PullToRefresh } from "../PullToRefresh";
import { StackHeader } from "../StackHeader";
import { SwipeableRow } from "../SwipeableRow";

const CHAT_MODEL_STORAGE_KEY = "subrosa:mobile:chat-model";

export function storedChatModel(): string {
  try {
    return localStorage.getItem(CHAT_MODEL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

type AgentScreenProps = {
  onOpenSession: (sessionId?: string) => void;
  /** Resolves (creating if needed) the shared Archive folder id. */
  ensureArchiveFolder: () => Promise<string | undefined>;
  archiveFolderId?: string;
  /** Present when the list is pushed over a conversation (the default shape). */
  onBack?: () => void;
};

/** Session list for the mobile chat (agent-lite), with swipe to archive
 * (the shared Archive folder, via session_folders) or delete. */
export function AgentScreen({
  onOpenSession,
  ensureArchiveFolder,
  archiveFolderId,
  onBack,
}: AgentScreenProps) {
  const [tasks, setTasks] = useState<AgentTaskDto[]>([]);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<AgentTaskDto | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const sessions = listAgentTasks()
      .then((response) => {
        setTasks(response.items);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        // A silent failure here read as "you have no chats"; name it instead.
        setLoadError(friendlyErrorMessage(err, "Couldn't load your chats."));
      });
    const folders = listSessionFolders()
      .then((rows) => {
        if (!archiveFolderId) {
          setArchivedIds(new Set());
          return;
        }
        setArchivedIds(
          new Set(
            rows.filter((row) => row.folderId === archiveFolderId).map((row) => row.sessionId),
          ),
        );
      })
      .catch(() => undefined);
    return Promise.all([sessions, folders]).finally(() => setLoading(false));
  }, [archiveFolderId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const archive = useCallback(
    async (taskId: string) => {
      const folderId = archiveFolderId ?? (await ensureArchiveFolder());
      if (!folderId) return;
      await assignSessionToFolder(taskId, folderId).catch(() => undefined);
      refresh();
    },
    [archiveFolderId, ensureArchiveFolder, refresh],
  );

  const restore = useCallback(
    async (taskId: string) => {
      if (!archiveFolderId) return;
      await removeSessionFromFolder(taskId, archiveFolderId).catch(() => undefined);
      refresh();
    },
    [archiveFolderId, refresh],
  );

  const remove = useCallback(
    async (taskId: string) => {
      await deleteAgentTask(taskId).catch(() => undefined);
      refresh();
    },
    [refresh],
  );

  const active = tasks.filter((task) => !archivedIds.has(task.id));
  const archived = tasks.filter((task) => archivedIds.has(task.id));

  const renderRow = (task: AgentTaskDto, isArchived: boolean) => (
    <li key={task.id}>
      <SwipeableRow
        actions={[
          isArchived
            ? { label: "Restore", tone: "neutral", onAction: () => void restore(task.id) }
            : { label: "Archive", tone: "neutral", onAction: () => void archive(task.id) },
          { label: "Delete", tone: "destructive", onAction: () => setConfirmDelete(task) },
        ]}
      >
        <button type="button" className="mobile-note-row" onClick={() => onOpenSession(task.id)}>
          <span className="mobile-note-row-body">
            <span className="mobile-note-row-title">
              {task.title.trim() || task.prompt.trim() || "New chat"}
            </span>
            <span className="mobile-note-row-subtitle">
              {task.messages.at(-1)?.content?.slice(0, 80) ?? ""}
            </span>
          </span>
        </button>
      </SwipeableRow>
    </li>
  );

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title="Chats"
        large
        onBack={onBack}
        trailing={
          <button
            type="button"
            className="mobile-icon-button"
            aria-label="New chat"
            onClick={() => onOpenSession(undefined)}
          >
            <IconPlusMedium size={20} />
          </button>
        }
      />
      <PullToRefresh className="mobile-list-scroll" onRefresh={refresh}>
        {loading ? (
          <ul className="mobile-note-list" aria-hidden>
            {[0, 1, 2].map((row) => (
              <li key={row} className="mobile-skeleton-row">
                <span className="mobile-skeleton-bar" style={{ width: "62%" }} />
                <span className="mobile-skeleton-bar" style={{ width: "84%" }} />
              </li>
            ))}
          </ul>
        ) : loadError && active.length === 0 && archived.length === 0 ? (
          <EmptyState
            icon={<IconBubble3 size={28} />}
            title="Couldn't load your chats"
            description={loadError}
            action={
              <button type="button" className="mobile-chip-button" onClick={() => void refresh()}>
                Try again
              </button>
            }
          />
        ) : active.length === 0 && archived.length === 0 ? (
          <EmptyState
            icon={<IconBubble3 size={28} />}
            title="Ask about your notes"
            description="Start a chat to search your meetings and the web."
            action={
              <button
                type="button"
                className="mobile-chip-button"
                onClick={() => onOpenSession(undefined)}
              >
                New chat
              </button>
            }
          />
        ) : (
          <>
            <ul className="mobile-note-list">{active.map((task) => renderRow(task, false))}</ul>
            {archived.length > 0 ? (
              <>
                <button
                  type="button"
                  className="mobile-archived-toggle"
                  onClick={() => setShowArchived((value) => !value)}
                >
                  {showArchived ? "Hide archived" : `Archived (${archived.length})`}
                </button>
                {showArchived ? (
                  <ul className="mobile-note-list">
                    {archived.map((task) => renderRow(task, true))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </PullToRefresh>
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this chat?"
        description="The conversation and its messages are removed from this device."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}

type AgentSessionScreenProps = {
  sessionId?: string;
  /** Absent when the conversation is the Chat tab's root screen. */
  onBack?: () => void;
  /** Reports the lazily created task id so the shell can restore it later. */
  onSessionCreated?: (sessionId: string) => void;
  /** Opens an existing chat (used after forking onto another model). */
  onOpenSession?: (sessionId: string) => void;
  onOpenHistory?: () => void;
  onNewChat?: () => void;
};

/** One chat thread: history + composer + live status while agent-lite runs. */
export function AgentSessionScreen({
  sessionId,
  onBack,
  onSessionCreated,
  onOpenSession,
  onOpenHistory,
  onNewChat,
}: AgentSessionScreenProps) {
  const [task, setTask] = useState<AgentTaskDto | null>(null);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<AgentLiteStatusDto | null>(null);
  // The reply as it is being written. Rendered as a live assistant bubble and
  // cleared by the done event, which carries the persisted message.
  const [streamed, setStreamed] = useState("");
  // The ordered stages of the current run, so the status bubble reads as a
  // short activity log (thinking -> searching notes -> searching web) rather
  // than a single flickering line.
  const [steps, setSteps] = useState<AgentLiteStatusDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A failed turn leaves the user's message persisted but unanswered, so it can
  // be re-run without retyping (optionally on a different model). `canRetry`
  // gates the "Try again" affordance on the error; the ref keeps the failed
  // turn's attachment payloads (cleared from the composer) for the re-run.
  const [canRetry, setCanRetry] = useState(false);
  const retryAttachmentsRef = useRef<AgentLiteAttachment[]>([]);
  const [model, setModel] = useState(storedChatModel);
  const [models, setModels] = useState<MediaModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<AgentLiteAttachment[]>([]);
  const [animatingId, setAnimatingId] = useState<string | null>(null);
  const [dictating, setDictating] = useState(false);
  const knownIdsRef = useRef<Set<string> | null>(null);
  const taskIdRef = useRef<string | undefined>(sessionId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is at (or near) the newest message. Auto-scroll only
  // follows new content while pinned, so scrolling up to reread history is
  // never fought; a "jump to latest" pill appears instead.
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const keyboardInset = useKeyboardInset();
  const credits = useCarpeDiemCredits();
  // Last status stage felt through the Taptic Engine, so each stage of the
  // run (thinking -> searching notes -> searching web) ticks exactly once.
  const lastStepKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    getAgentTask(sessionId)
      .then((loaded) => {
        setTask(loaded);
        // Restore the model this session last ran with, so reopening a chat
        // keeps its model rather than snapping back to the global default.
        if (loaded.model) setModel(loaded.model);
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }, [sessionId]);

  useEffect(() => {
    fetchMediaCatalog()
      .then((catalog) => setModels(modelsOfType(catalog, "text")))
      .catch((err: unknown) => setModelsError(messageFromError(err)));
  }, []);

  useEffect(() => {
    const unlistenStatus = listen<AgentLiteStatusDto>(AGENT_LITE_STATUS_EVENT, (event) => {
      if (event.payload.taskId !== taskIdRef.current) return;
      // A soft tick per stage change: the phone reports progress in the hand
      // without the screen (a stage repeat stays silent).
      const stepKey = `${event.payload.stage}|${event.payload.detail ?? ""}`;
      if (lastStepKeyRef.current !== stepKey) {
        lastStepKeyRef.current = stepKey;
        hapticSelection();
      }
      setStage(event.payload);
      setSteps((prev) => {
        const last = prev.at(-1);
        if (last && last.stage === event.payload.stage && last.detail === event.payload.detail) {
          return prev;
        }
        return [...prev, event.payload];
      });
    });
    const unlistenDelta = listen<{ taskId: string; text: string }>(
      AGENT_LITE_DELTA_EVENT,
      (event) => {
        if (event.payload.taskId !== taskIdRef.current) return;
        setStreamed((current) => current + event.payload.text);
      },
    );
    const unlistenDone = listen<AgentTaskDto>(AGENT_LITE_DONE_EVENT, (event) => {
      if (event.payload.id !== taskIdRef.current) return;
      lastStepKeyRef.current = null;
      setTask(event.payload);
      setStage(null);
      setSteps([]);
      setStreamed("");
      setRunning(false);
      // Fire the "reply is ready" haptic here, off the canonical completion
      // signal, rather than off the invoke resolving: it lands reliably even
      // if the reply reached us through the event first. Errors are signalled
      // from send()'s catch (the run rejects), so only mark success here to
      // avoid a double buzz.
      if (event.payload.status === "completed") hapticNotify("success");
    });
    return () => {
      void unlistenStatus.then((fn) => fn());
      void unlistenDelta.then((fn) => fn());
      void unlistenDone.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [task?.messages.length, stage, streamed]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = pinned;
    setShowJump(!pinned);
  }, []);

  // Grow the composer with its content (up to a few lines, then scroll) so
  // multi-line drafts stay visible instead of hiding above a one-row box.
  useEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  // Replies that arrive during this visit type themselves out; history that
  // loads with the screen renders instantly.
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

  const jumpToLatest = useCallback(() => {
    pinnedRef.current = true;
    setShowJump(false);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, []);

  const selectModel = useCallback((modelId: string) => {
    setModel(modelId);
    setPickerOpen(false);
    try {
      // The global default seeds the model for the NEXT new chat.
      if (modelId) localStorage.setItem(CHAT_MODEL_STORAGE_KEY, modelId);
      else localStorage.removeItem(CHAT_MODEL_STORAGE_KEY);
    } catch {
      // Persistence is a nicety; the in-memory choice still applies.
    }
    // For an already-open chat, remember the switch on the session itself so it
    // survives reopen (independent of the global default). Best effort: a failed
    // write only means the picker will fall back to the default next time.
    const openTaskId = taskIdRef.current;
    if (openTaskId) {
      void setAgentTaskModel({ taskId: openTaskId, model: modelId }).catch(() => undefined);
    }
  }, []);

  // Fork this chat onto another model: a copy carrying the same transcript,
  // bound to the chosen model, opened in its own thread so the original stays
  // untouched (comparing two models, or reasking a busy turn on a fresh one).
  const forkChat = useCallback(
    (modelId: string) => {
      const sourceTaskId = taskIdRef.current;
      setPickerOpen(false);
      if (!sourceTaskId) return;
      void forkAgentTask({ sourceTaskId, model: modelId })
        .then((forked) => {
          hapticNotify("success");
          onOpenSession?.(forked.id);
        })
        .catch((err: unknown) => setError(messageFromError(err)));
    },
    [onOpenSession],
  );

  const addAttachment = useCallback((file: File) => {
    const isImage = file.type.startsWith("image/");
    if (isImage) {
      void downscaleImageFile(file)
        .then((data) => {
          setAttachments((current) => [...current, { kind: "image", name: file.name, data }]);
        })
        .catch(() => setError("This image could not be read."));
      return;
    }
    if (file.size > 512 * 1024) {
      setError("Text files up to 512 KB can be attached.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setAttachments((current) => [
          ...current,
          { kind: "text", name: file.name, data: reader.result as string },
        ]);
      }
    };
    reader.readAsText(file);
  }, []);

  const toggleDictation = useCallback(async () => {
    if (dictating) {
      setDictating(false);
      try {
        const result = await mobileDictationStop({ style: "standard" });
        setDraft((current) => (current ? `${current} ${result.text}` : result.text));
        hapticNotify("success");
      } catch (err) {
        setError(messageFromError(err));
      }
      return;
    }
    try {
      await mobileDictationStart();
      setDictating(true);
      hapticImpact("medium");
    } catch (err) {
      setError(messageFromError(err));
    }
  }, [dictating]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if ((!content && attachments.length === 0) || running) return;
    // Persisted history keeps a readable marker per attachment; the payloads
    // ride along for this turn only.
    const markers = attachments
      .map((entry) => `[${entry.kind === "image" ? "Image" : "File"}: ${entry.name}]`)
      .join(" ");
    const stored = [content, markers].filter(Boolean).join("\n") || markers;
    const turnAttachments = attachments;
    setDraft("");
    setAttachments([]);
    setError(null);
    setCanRetry(false);
    setStreamed("");
    setRunning(true);
    setSteps([]);
    lastStepKeyRef.current = null;
    hapticImpact("light");
    try {
      let current = task;
      if (!current) {
        current = await createAgentTask({
          prompt: stored,
          runPlaceholder: false,
          model: model || undefined,
        });
        taskIdRef.current = current.id;
        setTask(current);
        onSessionCreated?.(current.id);
        // Best-effort title; the chat continues regardless.
        void suggestAgentSessionTitle(stored).catch(() => undefined);
      } else {
        current = await sendAgentMessage({
          taskId: current.id,
          content: stored,
          runPlaceholder: false,
        });
        setTask(current);
      }
      // An image turn routes to a vision-capable model even when the chosen
      // chat model is text-only, so attaching a photo just works.
      const turnModel = resolveTurnModel({
        selectedModelId: model,
        models,
        hasImages: turnAttachments.some((entry) => entry.kind === "image"),
      });
      // A turn interrupted by a screen lock is finished by the background
      // sweep and announced with a notification, so ask for the permission the
      // first time the user actually sends something.
      void ensureNotificationPermission("chat");
      const finished = await agentLiteRun(
        current.id,
        turnModel || undefined,
        turnAttachments.length ? turnAttachments : undefined,
      );
      setTask(finished);
    } catch (err) {
      hapticNotify("error");
      setError(messageFromError(err));
      if (taskIdRef.current) {
        // The message is persisted but unanswered: offer a re-run (which can
        // use a freshly chosen model), keeping this turn's attachment payloads.
        retryAttachmentsRef.current = turnAttachments;
        setCanRetry(true);
        getAgentTask(taskIdRef.current)
          .then(setTask)
          .catch(() => undefined);
      } else {
        // Task creation itself failed, so nothing was persisted. Restore the
        // composer so the user's message and attachments are never lost.
        setDraft(content);
        setAttachments(turnAttachments);
      }
    } finally {
      setRunning(false);
      setStage(null);
      setSteps([]);
      setStreamed("");
    }
  }, [draft, attachments, running, task, model, models, onSessionCreated]);

  // Re-run the last (failed) turn without retyping. The message is already
  // persisted, so this only re-issues the run — and it uses the CURRENT model,
  // so switching the picker then retrying continues the chat on another model.
  const retryTurn = useCallback(async () => {
    const taskId = taskIdRef.current;
    if (!taskId || running) return;
    setError(null);
    setCanRetry(false);
    setStreamed("");
    setRunning(true);
    setSteps([]);
    lastStepKeyRef.current = null;
    hapticImpact("light");
    const turnAttachments = retryAttachmentsRef.current;
    try {
      const turnModel = resolveTurnModel({
        selectedModelId: model,
        models,
        hasImages: turnAttachments.some((entry) => entry.kind === "image"),
      });
      const finished = await agentLiteRun(
        taskId,
        turnModel || undefined,
        turnAttachments.length ? turnAttachments : undefined,
      );
      setTask(finished);
      retryAttachmentsRef.current = [];
    } catch (err) {
      hapticNotify("error");
      setError(messageFromError(err));
      setCanRetry(true);
      getAgentTask(taskId)
        .then(setTask)
        .catch(() => undefined);
    } finally {
      setRunning(false);
      setStage(null);
      setSteps([]);
      setStreamed("");
    }
  }, [running, model, models]);

  const stageLabel = stageText(stage?.stage ?? "thinking");
  // Prefer the catalog's display name ("Claude Opus 4.7") over the raw id.
  const activeModelLabel =
    models.find((entry) => entry.id === model)?.name || shortModelLabel(model) || "Default model";

  return (
    <div className="mobile-screen-root mobile-chat">
      <StackHeader
        title={task?.title.trim() || "New chat"}
        onBack={onBack}
        backLabel="Chats"
        trailing={
          <>
            {credits ? (
              // Compact form (no "credits" word): the pill shares the header
              // with the title and two buttons, unlike Studio's roomy one.
              <span className="mobile-credits-pill" aria-label="Available credits">
                {formatCredits(credits.availableCredits).replace(" credits", "")}
                {typeof credits.priceMultiplier === "number"
                  ? ` · x${credits.priceMultiplier.toFixed(2)}`
                  : ""}
              </span>
            ) : null}
            {onOpenHistory ? (
              <button
                type="button"
                className="mobile-icon-button"
                aria-label="Chat history"
                onClick={onOpenHistory}
              >
                <IconClock size={20} />
              </button>
            ) : null}
            {onNewChat ? (
              <button
                type="button"
                className="mobile-icon-button"
                aria-label="New chat"
                disabled={running}
                onClick={onNewChat}
              >
                <IconPlusMedium size={20} />
              </button>
            ) : null}
          </>
        }
      />
      <div className="mobile-chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {!task?.messages.length && !running ? (
          <div className="mobile-chat-hero">
            <span className="mobile-chat-hero-mark" aria-hidden>
              <BrandGradientMark />
            </span>
            <h2 className="mobile-chat-hero-greeting">{greeting()}</h2>
            <p className="mobile-chat-hero-hint">Ask about your notes, or have me write one.</p>
            {/* An empty chat with only a placeholder makes the user invent the
             * capability. These name what it can actually do now: read a note
             * in full, search the web, and write back. */}
            <div className="mobile-chat-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="mobile-chat-suggestion"
                  onClick={() => {
                    hapticSelection();
                    setDraft(suggestion);
                    chatInputRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
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
        {running && !streamed ? (
          <div className="mobile-chat-bubble mobile-chat-status" data-role="assistant">
            <ul className="mobile-chat-steps">
              {steps.map((step, i) => {
                const active = i === steps.length - 1;
                return (
                  <li
                    key={`${step.stage}-${i}`}
                    className="mobile-chat-step"
                    data-active={active ? "true" : undefined}
                  >
                    <span className="mobile-chat-step-icon" aria-hidden>
                      {active ? <Spinner aria-hidden /> : <IconCheckmark1Small size={12} />}
                    </span>
                    <span
                      className="mobile-chat-step-label"
                      data-shimmer={active ? "true" : undefined}
                    >
                      {stageText(step.stage)}
                      {step.detail ? ` · ${step.detail}` : ""}
                    </span>
                  </li>
                );
              })}
              {steps.length === 0 ? (
                <li className="mobile-chat-step" data-active="true">
                  <span className="mobile-chat-step-icon" aria-hidden>
                    <Spinner aria-hidden />
                  </span>
                  <span className="mobile-chat-step-label" data-shimmer="true">
                    {stageLabel}
                  </span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
        {error ? (
          <div className="mobile-chat-error" role="alert">
            <p className="mobile-dictation-error">{error}</p>
            {canRetry ? (
              <button type="button" className="mobile-chat-retry" onClick={() => void retryTurn()}>
                Try again
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {showJump ? (
        <button
          type="button"
          className="mobile-chat-jump"
          aria-label="Jump to latest message"
          onClick={jumpToLatest}
        >
          <IconArrowDown size={16} />
        </button>
      ) : null}
      <div
        className="mobile-chat-composer-stack"
        data-keyboard={keyboardInset > 0 ? "true" : undefined}
        style={{ marginBottom: keyboardInset }}
      >
        {attachments.length > 0 ? (
          <div className="mobile-chat-attachments">
            {attachments.map((entry, index) => (
              <button
                key={`${entry.name}-${index}`}
                type="button"
                className="mobile-chat-attachment"
                aria-label={`Remove ${entry.name}`}
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
              >
                {entry.kind === "image" ? (
                  <img src={entry.data} alt={entry.name} />
                ) : (
                  <span className="mobile-chat-attachment-file">{entry.name}</span>
                )}
                <span className="mobile-chat-attachment-remove" aria-hidden>
                  x
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="mobile-chat-composer-card">
          <input
            ref={attachInputRef}
            type="file"
            accept="image/*,.txt,.md,.csv,.json,text/plain"
            multiple
            hidden
            onChange={(event) => {
              for (const file of Array.from(event.target.files ?? [])) {
                addAttachment(file);
              }
              event.target.value = "";
            }}
          />
          <textarea
            ref={chatInputRef}
            className="mobile-chat-input"
            value={draft}
            placeholder="Ask about your notes"
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              // Pasting an image (long-press > Paste on iOS) attaches it
              // instead of dropping it: textareas cannot hold images.
              const files = Array.from(event.clipboardData?.items ?? [])
                .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (files.length === 0) return;
              event.preventDefault();
              for (const file of files) {
                addAttachment(
                  file.name
                    ? file
                    : new File([file], `pasted-${Date.now()}.png`, { type: file.type }),
                );
              }
            }}
          />
          <div className="mobile-chat-composer-row">
            <button
              type="button"
              className="mobile-composer-round"
              aria-label="Attach a file"
              onClick={() => attachInputRef.current?.click()}
            >
              <IconPaperclip1 size={17} />
            </button>
            <button
              type="button"
              className="mobile-composer-model"
              onClick={() => setPickerOpen(true)}
              aria-label="Choose model"
            >
              {activeModelLabel}
            </button>
            <span className="mobile-composer-spacer" />
            <button
              type="button"
              className="mobile-composer-round"
              data-active={dictating ? "true" : undefined}
              aria-label={dictating ? "Stop dictation" : "Dictate"}
              onClick={() => void toggleDictation()}
            >
              <IconMicrophone size={17} />
            </button>
            <button
              type="button"
              className="mobile-chat-send"
              aria-label="Send"
              disabled={(!draft.trim() && attachments.length === 0) || running}
              onClick={() => void send()}
            >
              <IconArrowUp size={18} />
            </button>
          </div>
        </div>
      </div>
      {pickerOpen ? (
        <ModelSheet
          title="Chat model"
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle:
              entry.supportsVision || entry.traits?.some((trait) => trait.includes("vision"))
                ? "vision · reads images"
                : undefined,
          }))}
          selectedId={model}
          defaultOption={{ label: "Default", subtitle: "Recommended model" }}
          error={modelsError}
          onSelect={selectModel}
          onFork={task ? forkChat : undefined}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

function shortModelLabel(modelId: string): string {
  if (!modelId) return "";
  return modelId.length > 18 ? `${modelId.slice(0, 17)}…` : modelId;
}

const STAGE_TEXT: Record<string, string> = {
  "searching-notes": "Searching your notes",
  "searching-web": "Searching the web",
  "searching-memory": "Recalling your memories",
  "searching-places": "Finding places",
  "searching-calendar": "Checking your calendar",
  "reading-note": "Reading a note",
  "writing-note": "Writing to your notes",
  remembering: "Remembering that",
  "reading-page": "Reading a page",
};

function stageText(stage: AgentLiteStatusDto["stage"]): string {
  return STAGE_TEXT[stage] ?? "Thinking";
}

/** Copies a finished reply to the clipboard, with a brief confirmation. */
function CopyReplyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      // Chat blocks paste as readable link lists, not JSON fences.
      await writeText(chatBlocksToClipboardText(text));
      hapticImpact("light");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Copy is a convenience; a transient clipboard failure is not worth a toast.
    }
  }, [text]);
  return (
    <button
      type="button"
      className="mobile-chat-copy"
      onClick={() => void copy()}
      aria-label="Copy reply"
    >
      {copied ? <IconCheckmark1Small size={13} /> : <IconClipboard size={13} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Camera photos are far larger than vision models need; cap the long edge
 * and re-encode as JPEG so requests stay fast and within body limits. Loads
 * through a data URL (not a blob URL): the app CSP allows `data:` images
 * only, and WKWebView decodes HEIC natively along the same path. */
async function downscaleImageFile(file: File, maxDim = 2048): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("file read failed"));
    reader.onerror = () => reject(new Error("file read failed"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("image decode failed"));
    element.src = original;
  });
  const scale = Math.min(1, maxDim / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Time-of-day greeting in the device language (French or English). */
/** Openers for an empty chat. Each one exercises a different tool, so the
 * first reply also teaches what the assistant reaches for. */
const SUGGESTIONS = [
  "Summarise my last meeting",
  "What did I work on this week?",
  "Remember that I prefer short replies",
];

function greeting(): string {
  const hour = new Date().getHours();
  const french = (navigator.language || "").toLowerCase().startsWith("fr");
  if (french) {
    if (hour < 5) return "Bonne nuit";
    if (hour < 12) return "Bonjour";
    if (hour < 18) return "Bon après-midi";
    return "Bonsoir";
  }
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Progressive reveal of a fresh reply — the backend is not streaming, so the
 * finished text plays back at reading speed instead of appearing as a wall.
 * The "reply is ready" buzz fires once on arrival (the done listener); while
 * the text types out, a sparse selection tick (~every 190 ms, never per frame)
 * makes the phone purr along without the Taptic Engine coalescing it into
 * mush or swallowing that arrival buzz. */
function TypewriterMarkdown({
  text,
  onTick,
  onDone,
}: {
  text: string;
  onTick?: () => void;
  onDone?: () => void;
}) {
  const [visible, setVisible] = useState(0);
  const onTickRef = useRef(onTick);
  const onDoneRef = useRef(onDone);
  onTickRef.current = onTick;
  onDoneRef.current = onDone;

  useEffect(() => {
    let index = 0;
    let frame = 0;
    // ~3 seconds for a long answer, faster for short ones.
    const step = Math.max(3, Math.ceil(text.length / 130));
    const interval = window.setInterval(() => {
      index = Math.min(text.length, index + step);
      frame += 1;
      // Every 8th frame at 24 ms/frame keeps ticks ~190 ms apart.
      if (frame % 8 === 0 && index < text.length) hapticSelection();
      setVisible(index);
      onTickRef.current?.();
      if (index >= text.length) {
        window.clearInterval(interval);
        onDoneRef.current?.();
      }
    }, 24);
    return () => window.clearInterval(interval);
  }, [text]);

  // streaming while the reveal runs: a subrosa fence cut mid-payload renders
  // as a card skeleton instead of a flash of half-written JSON.
  return <SimpleMarkdown text={text.slice(0, visible)} streaming={visible < text.length} />;
}
