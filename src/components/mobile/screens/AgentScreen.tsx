import "../../../styles/chat-reading.css";
import { useAccountSyncUpdated } from "../../../lib/account-sync-events";
import {
  agentLiteCancel,
  agentLiteEditBranch,
  agentLiteEditLast,
  agentLiteRegenerate,
} from "../../../lib/agent-lite-controls";
import { type AgentLiteDeltaDto, applyAgentLiteDelta } from "../../../lib/agent-lite-delta";
import {
  type ChatSessionItem,
  type HistorySection,
  historySection,
  listChatSessions,
  onChatTitle,
  renameAgentTask,
} from "../../../lib/chat-titles";
import { t } from "../../../lib/i18n";
import { listen } from "@tauri-apps/api/event";
import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconBarsTwo } from "central-icons/IconBarsTwo";
import { IconBrain } from "central-icons/IconBrain";
import { IconBubblePlus } from "central-icons/IconBubblePlus";
import { IconCalendar2 } from "central-icons/IconCalendar2";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconClock } from "central-icons/IconClock";
import { IconImageSparkle } from "central-icons/IconImageSparkle";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconSparklesSoft } from "central-icons/IconSparklesSoft";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconLibrary } from "central-icons/IconLibrary";
import { IconSunrise } from "central-icons/IconSunrise";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { readContextGauge } from "../../../lib/context-gauge";
import { useDefaultChatModelId } from "../../../lib/default-chat-model";
import { friendlyErrorMessage, messageFromError, taskErrorMessage } from "../../../lib/errors";
import { hapticImpact, hapticNotify, hapticSelection } from "../../../lib/haptics";
import { SimpleMarkdown } from "../../../lib/simple-markdown";
import { fetchMediaCatalog, formatCredits, modelsOfType } from "../../../lib/studio/catalog";
import { ensureNotificationPermission } from "../../../lib/notifications";
import {
  effortForModel,
  type ReasoningEffort,
  storedReasoningEffort,
  storeReasoningEffort,
  supportsReasoningEffort,
} from "../../../lib/reasoning-effort";
import { resolveTurnModel } from "../../../lib/vision-routing";
import type { MediaModel } from "../../../lib/studio/types";
import {
  AGENT_LITE_DELTA_EVENT,
  AGENT_LITE_DONE_EVENT,
  AGENT_LITE_STATUS_EVENT,
  type AgentLiteAttachment,
  type AgentLiteStatusDto,
  type AgentMessageDto,
  type AgentTaskDto,
  agentLiteRun,
  assignSessionToFolder,
  createAgentTask,
  deleteAgentTask,
  forkAgentTask,
  getAgentTask,
  listSessionFolders,
  removeSessionFromFolder,
  sendAgentMessage,
  setAgentTaskModel,
} from "../../../lib/tauri";
import { readableModelName } from "../../../lib/model-names";
import {
  createTemporaryChat,
  isTemporaryChat,
  markTemporaryChat,
  useIsTemporaryChat,
  useTemporaryChatHold,
  useTemporaryDraft,
} from "../../../lib/temporary-chat";
import { TemporaryChatBanner, TemporaryChatToggle } from "../../agent/TemporaryChat";
import { ShareConversationDialog } from "../../share/ShareNoteDialog";
import { useCanShare } from "../../share/useCanShare";
import { BrandMark } from "../../brand/Marks";
import { ContextGauge } from "../../chat/ContextGauge";
import { ChatAmbient } from "../ChatAmbient";
import { ChatComposer } from "../ChatComposer";
import { ChatExportButton } from "../ChatExportButton";
import { MemorySourcesChip } from "../MemorySourcesChip";
import {
  ChatSteps,
  hasAttachmentMarkers,
  interruptedAttachmentMessage,
  QuestionActions,
  ReplyActions,
  stageText,
  TypewriterMarkdown,
  withAttachmentMarkers,
} from "../ChatParts";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { EmptyState } from "../../ui/EmptyState";
import { Spinner } from "../../ui/Spinner";
import { ModelSheet } from "../ModelSheet";
import { ReasoningEffortRow } from "../ReasoningEffortRow";
import { NameSheet } from "../NameSheet";
import { formatNoteTime } from "./NoteRow";
import { PullToRefresh } from "../PullToRefresh";
import { StackHeader } from "../StackHeader";
import { ComposerModes, studyChatStarted } from "../../agent/ComposerModes";
import { SwipeableRow } from "../SwipeableRow";

const CHAT_MODEL_STORAGE_KEY = "subrosa:mobile:chat-model";
const CHAT_EFFORT_STORAGE_KEY = "subrosa:mobile:chat-reasoning-effort";

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
  /** The Library: what the chats made and what was kept from them. */
  onOpenLibrary?: () => void;
  /** Today: the daily brief, results to review, assignments (ADR-0091). */
  onOpenToday?: () => void;
};

/** Session list for the mobile chat (agent-lite), with swipe to archive
 * (the shared Archive folder, via session_folders) or delete. */
export function AgentScreen({
  onOpenSession,
  ensureArchiveFolder,
  archiveFolderId,
  onBack,
  onOpenLibrary,
  onOpenToday,
}: AgentScreenProps) {
  const [tasks, setTasks] = useState<ChatSessionItem[]>([]);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<ChatSessionItem | null>(null);
  const [renaming, setRenaming] = useState<ChatSessionItem | null>(null);
  const [sharing, setSharing] = useState<ChatSessionItem | null>(null);
  const canShare = useCanShare();
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const sessions = listChatSessions()
      .then((items) => {
        setTasks(items);
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

  useAccountSyncUpdated(refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // A title named after the first reply lands while the list is open.
  useEffect(
    () =>
      onChatTitle(({ taskId, title }) =>
        setTasks((current) =>
          current.map((task) => (task.id === taskId ? { ...task, title } : task)),
        ),
      ),
    [],
  );

  const archive = useCallback(
    async (taskId: string) => {
      setActionError(null);
      try {
        const folderId = archiveFolderId ?? (await ensureArchiveFolder());
        if (!folderId) throw new Error(t("Couldn't archive this chat."));
        await assignSessionToFolder(taskId, folderId);
        await refresh();
      } catch (err) {
        setActionError(friendlyErrorMessage(err, t("Couldn't archive this chat.")));
      }
    },
    [archiveFolderId, ensureArchiveFolder, refresh],
  );

  const restore = useCallback(
    async (taskId: string) => {
      if (!archiveFolderId) return;
      setActionError(null);
      try {
        await removeSessionFromFolder(taskId, archiveFolderId);
        await refresh();
      } catch (err) {
        setActionError(friendlyErrorMessage(err, t("Couldn't restore this chat.")));
      }
    },
    [archiveFolderId, refresh],
  );

  const remove = useCallback(
    async (taskId: string) => {
      setActionError(null);
      try {
        await deleteAgentTask(taskId);
        await refresh();
      } catch (err) {
        setActionError(friendlyErrorMessage(err, t("Couldn't delete this chat.")));
      }
    },
    [refresh],
  );

  const rename = useCallback(async (taskId: string, title: string) => {
    setActionError(null);
    try {
      const renamed = await renameAgentTask(taskId, title);
      setTasks((current) =>
        current.map((task) => (task.id === taskId ? { ...task, title: renamed.title } : task)),
      );
    } catch (err) {
      setActionError(friendlyErrorMessage(err, t("Couldn't rename this chat.")));
    }
  }, []);

  const needle = query.trim().toLowerCase();
  const matches = (task: ChatSessionItem) =>
    !needle ||
    chatTitle(task).toLowerCase().includes(needle) ||
    (task.lastMessagePreview ?? "").toLowerCase().includes(needle);
  const active = tasks.filter((task) => !archivedIds.has(task.id) && matches(task));
  const archived = tasks.filter((task) => archivedIds.has(task.id) && matches(task));
  const sections = HISTORY_SECTIONS.map((section) => ({
    ...section,
    items: active.filter((task) => historySection(task.updatedAt) === section.id),
  })).filter((section) => section.items.length > 0);

  const renderRow = (task: ChatSessionItem, isArchived: boolean) => {
    const title = chatTitle(task);
    const time = formatNoteTime(task.updatedAt);
    const preview = task.lastMessagePreview
      ? task.lastMessageRole === "user"
        ? t("You: {text}", { text: task.lastMessagePreview })
        : task.lastMessagePreview
      : "";
    return (
      <li key={task.id}>
        <SwipeableRow
          actions={[
            { label: t("Rename"), tone: "neutral", onAction: () => setRenaming(task) },
            isArchived
              ? { label: t("Restore"), tone: "neutral", onAction: () => void restore(task.id) }
              : { label: t("Archive"), tone: "neutral", onAction: () => void archive(task.id) },
            ...(canShare
              ? [{ label: t("Share"), tone: "neutral" as const, onAction: () => setSharing(task) }]
              : []),
            { label: t("Delete"), tone: "destructive", onAction: () => setConfirmDelete(task) },
          ]}
        >
          <button
            type="button"
            className="mobile-note-row mobile-chat-row"
            // One sentence for VoiceOver: what the chat is, when, and where
            // it left off, rather than three fragments read one by one.
            aria-label={[title, time, preview].filter(Boolean).join(", ")}
            onClick={() => onOpenSession(task.id)}
          >
            <span className="mobile-note-row-body">
              <span className="mobile-note-row-title mobile-chat-row-title">{title}</span>
              {preview ? <span className="mobile-note-row-subtitle">{preview}</span> : null}
            </span>
            <span className="mobile-note-row-time">{time}</span>
          </button>
        </SwipeableRow>
      </li>
    );
  };

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={t("Chats")}
        large
        onBack={onBack}
        trailing={
          <>
            {onOpenToday ? (
              <button
                type="button"
                className="mobile-icon-button"
                aria-label={t("Today")}
                onClick={onOpenToday}
              >
                <IconSunrise size={20} />
              </button>
            ) : null}
            {onOpenLibrary ? (
              <button
                type="button"
                className="mobile-icon-button"
                aria-label={t("Library")}
                onClick={onOpenLibrary}
              >
                <IconLibrary size={20} />
              </button>
            ) : null}
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={t("New chat")}
              onClick={() => onOpenSession(undefined)}
            >
              <IconPlusMedium size={20} />
            </button>
          </>
        }
      />
      {tasks.length > 0 ? (
        <div className="mobile-search">
          <IconMagnifyingGlass size={16} aria-hidden />
          <input
            type="search"
            placeholder={t("Search chats")}
            aria-label={t("Search chats")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
      ) : null}
      <PullToRefresh className="mobile-list-scroll" onRefresh={refresh}>
        {actionError ? (
          <p className="mobile-dictation-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {loading ? (
          <ul className="mobile-note-list" aria-hidden>
            {[0, 1, 2].map((row) => (
              <li key={row} className="mobile-skeleton-row">
                <span className="mobile-skeleton-bar" style={{ width: "62%" }} />
                <span className="mobile-skeleton-bar" style={{ width: "84%" }} />
              </li>
            ))}
          </ul>
        ) : loadError && tasks.length === 0 ? (
          <EmptyState
            icon={<IconBubble3 size={28} />}
            title={t("Couldn't load your chats")}
            description={loadError}
            action={
              <button type="button" className="mobile-chip-button" onClick={() => void refresh()}>
                {t("Try again")}
              </button>
            }
          />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={<IconBubble3 size={28} />}
            title={t("Ask about your notes")}
            description={t("Start a chat to search your meetings and the web.")}
            action={
              <button
                type="button"
                className="mobile-chip-button"
                onClick={() => onOpenSession(undefined)}
              >
                {t("New chat")}
              </button>
            }
          />
        ) : active.length === 0 && archived.length === 0 ? (
          <EmptyState
            icon={<IconMagnifyingGlass size={28} />}
            title={t("No matches")}
            description={t("Try a different search.")}
          />
        ) : (
          <>
            {sections.map((section) => (
              <section key={section.id} aria-label={section.label}>
                <h2 className="mobile-list-section-title">{section.label}</h2>
                <ul className="mobile-note-list">
                  {section.items.map((task) => renderRow(task, false))}
                </ul>
              </section>
            ))}
            {archived.length > 0 ? (
              <>
                <button
                  type="button"
                  className="mobile-archived-toggle"
                  aria-expanded={showArchived}
                  onClick={() => setShowArchived((value) => !value)}
                >
                  {showArchived
                    ? t("Hide archived")
                    : t("Archived ({count})", { count: archived.length })}
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
      {renaming ? (
        <NameSheet
          title={t("Rename chat")}
          label={t("Chat name")}
          initialValue={chatTitle(renaming)}
          confirmLabel={t("Rename")}
          onSubmit={(title) => {
            const taskId = renaming.id;
            setRenaming(null);
            void rename(taskId, title);
          }}
          onClose={() => setRenaming(null)}
        />
      ) : null}
      {sharing ? (
        <ShareConversationDialog
          target={{ taskId: sharing.id }}
          open={true}
          onClose={() => setSharing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("Delete this chat?")}
        description={t("The conversation and its messages are removed from this device.")}
        confirmLabel={t("Delete")}
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

const HISTORY_SECTIONS: Array<{ id: HistorySection; label: string }> = [
  { id: "today", label: t("Today") },
  { id: "yesterday", label: t("Yesterday") },
  { id: "week", label: t("Previous 7 days") },
  { id: "older", label: t("Older") },
];

/** What a chat is called: its name, else its first words, else "New chat". */
function chatTitle(task: Pick<AgentTaskDto, "title" | "prompt">): string {
  return task.title.trim() || task.prompt.trim() || t("New chat");
}

type AgentSessionScreenProps = {
  sessionId?: string;
  /** A new chat started in this project is filed there before its first
   * turn runs, so that turn already reads the project (ADR-0085). */
  projectFolderId?: string;
  /** Absent when the conversation is the Chat tab's root screen. */
  onBack?: () => void;
  /** Reports the lazily created task id so the shell can restore it later. */
  onSessionCreated?: (sessionId: string) => void;
  /** Opens an existing chat (used after forking onto another model). */
  onOpenSession?: (sessionId: string) => void;
  onOpenHistory?: () => void;
  onNewChat?: () => void;
  /** "Generate an image" on the opening: hands what was typed to Studio. */
  onGenerateImage?: (prompt: string) => void;
  /** Text to open the composer with (`subrosa://chat?q=` or a Shortcuts
   * action). Read once, at mount. */
  initialDraft?: string;
  /** Send the initial draft as soon as the chat can. Only a request written
   * by the app's own Shortcuts action may ask for this: a link from any page
   * could otherwise make the phone send a message on its owner's behalf. */
  autoSend?: boolean;
  /** Told once the initial draft has been taken, so it is not taken again. */
  onInitialDraftUsed?: () => void;
};

/** One chat thread: history + composer + live status while agent-lite runs. */
export function AgentSessionScreen({
  sessionId,
  projectFolderId,
  onBack,
  onSessionCreated,
  onOpenSession,
  onOpenHistory,
  onNewChat,
  onGenerateImage,
  initialDraft,
  autoSend = false,
  onInitialDraftUsed,
}: AgentSessionScreenProps) {
  const [task, setTask] = useState<AgentTaskDto | null>(null);
  // A temporary chat (ADR-0083) is chosen before its first message, and is
  // deleted as soon as this screen leaves it.
  const temporaryDraftOn = useTemporaryDraft();
  const temporary = useIsTemporaryChat(task?.id) || (!task && !sessionId && temporaryDraftOn);
  useTemporaryChatHold(task?.id, "task");
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [loadingTask, setLoadingTask] = useState(Boolean(sessionId));
  const [taskLoadFailed, setTaskLoadFailed] = useState(false);
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
  // A new chat started in a project whose filing failed (ADR-0085).
  const unfiledProjectRef = useRef(false);
  const [model, setModel] = useState(storedChatModel);
  const [models, setModels] = useState<MediaModel[]>([]);
  const defaultModelId = useDefaultChatModelId();
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<AgentLiteAttachment[]>([]);
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(() =>
    storedReasoningEffort(CHAT_EFFORT_STORAGE_KEY),
  );
  // A question being edited in the composer. The last one is rewritten in
  // place; an earlier one is asked again in a new chat, so nothing already
  // read disappears (ADR-0079).
  const [editing, setEditing] = useState<{ messageId: string; last: boolean } | null>(null);
  const [animatingId, setAnimatingId] = useState<string | null>(null);
  const knownIdsRef = useRef<Set<string> | null>(null);
  const taskIdRef = useRef<string | undefined>(sessionId);
  const taskRevisionRef = useRef(0);
  const loadRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const currentSessionRef = useRef(sessionId);
  currentSessionRef.current = sessionId;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is at (or near) the newest message. Auto-scroll only
  // follows new content while pinned, so scrolling up to reread history is
  // never fought; a "jump to latest" pill appears instead.
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const credits = useCarpeDiemCredits();
  // Last status stage felt through the Taptic Engine, so each stage of the
  // run (thinking -> searching notes -> searching web) ticks exactly once.
  const lastStepKeyRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestRef.current += 1;
    };
  }, []);

  const loadTask = useCallback(async () => {
    if (!sessionId) return;
    const request = ++loadRequestRef.current;
    taskIdRef.current = sessionId;
    const isCurrent = () =>
      mountedRef.current &&
      request === loadRequestRef.current &&
      currentSessionRef.current === sessionId;
    setLoadingTask(true);
    setTaskLoadFailed(false);
    try {
      const loaded = await getAgentTask(sessionId);
      if (!isCurrent()) return;
      setTask(loaded);
      taskIdRef.current = loaded.id;
      const awaitingReply = loaded.messages.at(-1)?.role === "user";
      const active = awaitingReply && ["queued", "running", "paused"].includes(loaded.status);
      runningRef.current = active;
      setRunning(active);
      const missingAttachments = hasAttachmentMarkers(loaded.messages.at(-1)?.content ?? "");
      setCanRetry(awaitingReply && loaded.status === "failed" && !missingAttachments);
      setError(
        loaded.status === "failed"
          ? missingAttachments
            ? interruptedAttachmentMessage()
            : taskErrorMessage(loaded.lastError)
          : null,
      );
      if (loaded.model) setModel(loaded.model);
    } catch (err) {
      if (!isCurrent()) return;
      setError(messageFromError(err));
      setTaskLoadFailed(true);
    } finally {
      if (isCurrent()) setLoadingTask(false);
    }
  }, [sessionId]);
  useAccountSyncUpdated(async () => {
    if (!runningRef.current) await loadTask();
  });

  const refreshAfterFailure = useCallback((taskId: string) => {
    const revision = taskRevisionRef.current;
    const session = currentSessionRef.current;
    void getAgentTask(taskId)
      .then((loaded) => {
        if (
          !mountedRef.current ||
          revision !== taskRevisionRef.current ||
          currentSessionRef.current !== session ||
          taskIdRef.current !== taskId
        )
          return;
        setTask(loaded);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // A newly created task is already in memory. Reloading it here could
    // overwrite a reply that arrives before the history request resolves.
    if (sessionId && taskIdRef.current === sessionId && task) return;
    void loadTask();
  }, [loadTask, sessionId, task]);

  useEffect(() => {
    fetchMediaCatalog()
      .then((catalog) => setModels(modelsOfType(catalog, "text")))
      .catch((err: unknown) => setModelsError(messageFromError(err)));
  }, []);

  // The title the model names after the first reply replaces the first words
  // in the header without a reload.
  useEffect(
    () =>
      onChatTitle(({ taskId, title }) => {
        if (taskId !== taskIdRef.current) return;
        setTask((current) => (current ? { ...current, title } : current));
      }),
    [],
  );

  useEffect(() => {
    const unlistenStatus = listen<AgentLiteStatusDto>(AGENT_LITE_STATUS_EVENT, (event) => {
      if (!mountedRef.current || event.payload.taskId !== taskIdRef.current) return;
      // A soft tick per stage change: the phone reports progress in the hand
      // without the screen (a stage repeat stays silent).
      const stepKey = `${event.payload.stage}|${event.payload.detail ?? ""}`;
      if (lastStepKeyRef.current !== stepKey) {
        lastStepKeyRef.current = stepKey;
        hapticSelection();
      }
      runningRef.current = true;
      setRunning(true);
      setStage(event.payload);
      setSteps((prev) => {
        const last = prev.at(-1);
        if (last && last.stage === event.payload.stage && last.detail === event.payload.detail) {
          return prev;
        }
        return [...prev, event.payload];
      });
    });
    const unlistenDelta = listen<AgentLiteDeltaDto>(AGENT_LITE_DELTA_EVENT, (event) => {
      if (!mountedRef.current || event.payload.taskId !== taskIdRef.current) return;
      setStreamed((current) => applyAgentLiteDelta(current, event.payload));
    });
    const unlistenDone = listen<AgentTaskDto>(AGENT_LITE_DONE_EVENT, (event) => {
      if (!mountedRef.current || event.payload.id !== taskIdRef.current) return;
      taskRevisionRef.current += 1;
      loadRequestRef.current += 1;
      setLoadingTask(false);
      setTaskLoadFailed(false);
      lastStepKeyRef.current = null;
      setTask(event.payload);
      setStage(null);
      setSteps([]);
      setStreamed("");
      runningRef.current = false;
      setRunning(false);
      const missingAttachments =
        retryAttachmentsRef.current.length === 0 &&
        hasAttachmentMarkers(event.payload.messages.at(-1)?.content ?? "");
      setCanRetry(event.payload.status === "failed" && !missingAttachments);
      setError(
        event.payload.status === "failed"
          ? missingAttachments
            ? interruptedAttachmentMessage()
            : taskErrorMessage(event.payload.lastError)
          : null,
      );
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: the new content is the trigger, not an input.
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

  // The effort a turn on `turnModel` asks for. Only a model whose catalog
  // entry honours one gets it; the choice is kept for the next one that does.
  const effortFor = useCallback(
    (turnModel: string) =>
      effortForModel(
        models.find((entry) => entry.id === turnModel),
        effort,
      ),
    [models, effort],
  );

  const selectEffort = useCallback((next: ReasoningEffort | undefined) => {
    setEffort(next);
    storeReasoningEffort(CHAT_EFFORT_STORAGE_KEY, next);
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
          // A branch of a temporary chat is temporary too (Rust copies the flag).
          if (isTemporaryChat(sourceTaskId)) markTemporaryChat(forked.id);
          onOpenSession?.(forked.id);
        })
        .catch((err: unknown) => setError(messageFromError(err)));
    },
    [onOpenSession],
  );

  const send = useCallback(async () => {
    const content = draft.trim();
    if (
      (!content && attachments.length === 0) ||
      runningRef.current ||
      loadingTask ||
      taskLoadFailed
    )
      return;
    runningRef.current = true;
    taskRevisionRef.current += 1;
    const submittedDraft = draft;
    let persistedTaskId: string | undefined;
    // Persisted history keeps a readable marker per attachment; the payloads
    // ride along for this turn only.
    const stored = withAttachmentMarkers(content, attachments);
    const turnAttachments = attachments;
    retryAttachmentsRef.current = turnAttachments;
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
        current = temporary
          ? await createTemporaryChat({ prompt: stored, model: model || undefined })
          : await createAgentTask({
              prompt: stored,
              runPlaceholder: false,
              model: model || undefined,
            });
        taskIdRef.current = current.id;
        setTask(current);
        onSessionCreated?.(current.id);
        // Study mode switched on before the chat existed (ADR-0089).
        await studyChatStarted(current.id);
        // The question is stored from here: a failure below is retried, not
        // put back in the composer (sending it again would ask it twice).
        persistedTaskId = current.id;
        if (projectFolderId) {
          try {
            await assignSessionToFolder(current.id, projectFolderId);
          } catch (err) {
            // Not run outside the project it was started in: "Try again"
            // files it first.
            unfiledProjectRef.current = true;
            throw err;
          }
        }
        // The title is named by the model after the first reply, in Rust
        // (crate::chat_titles), and arrives on CHAT_TITLE_EVENT.
      } else {
        current = await sendAgentMessage({
          taskId: current.id,
          content: stored,
          runPlaceholder: false,
        });
        setTask(current);
      }
      persistedTaskId = current.id;
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
        effortFor(turnModel),
      );
      setTask(finished);
    } catch (err) {
      hapticNotify("error");
      setError(messageFromError(err));
      if (persistedTaskId) {
        // The message is persisted but unanswered: offer a re-run (which can
        // use a freshly chosen model), keeping this turn's attachment payloads.
        retryAttachmentsRef.current = turnAttachments;
        setCanRetry(true);
        refreshAfterFailure(persistedTaskId);
      } else {
        // A failed write in an EXISTING chat is just as unsaved as a failed
        // new chat. Preserve any next draft entered while the write waited.
        setDraft((current) => (current ? `${submittedDraft}\n${current}` : submittedDraft));
        setAttachments((current) => [...turnAttachments, ...current]);
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      setStage(null);
      setSteps([]);
      setStreamed("");
    }
  }, [
    draft,
    attachments,
    loadingTask,
    taskLoadFailed,
    task,
    temporary,
    model,
    models,
    effortFor,
    onSessionCreated,
    projectFolderId,
    refreshAfterFailure,
  ]);

  // The initial draft is taken once. With `autoSend` it is sent as soon as
  // the thread is ready; otherwise it waits in the composer for the person.
  const initialDraftTaken = useRef(false);
  useEffect(() => {
    if (initialDraftTaken.current || !initialDraft) return;
    if (autoSend && (loadingTask || taskLoadFailed)) return;
    initialDraftTaken.current = true;
    onInitialDraftUsed?.();
    if (autoSend) void send();
  }, [initialDraft, autoSend, loadingTask, taskLoadFailed, onInitialDraftUsed, send]);

  // One turn the screen runs on an existing chat (retry, regenerate, an edit
  // of the last question): the same running state and failure handling as a
  // send. A failure keeps the persisted question re-runnable, with `retry`
  // attachments for the "Try again" that follows.
  const runOwnTurn = useCallback(
    async (
      taskId: string,
      start: () => Promise<AgentTaskDto>,
      retry: AgentLiteAttachment[] = [],
    ) => {
      if (runningRef.current) return;
      runningRef.current = true;
      taskRevisionRef.current += 1;
      setError(null);
      setCanRetry(false);
      setStreamed("");
      setRunning(true);
      setSteps([]);
      lastStepKeyRef.current = null;
      hapticImpact("light");
      retryAttachmentsRef.current = retry;
      try {
        setTask(await start());
        retryAttachmentsRef.current = [];
      } catch (err) {
        hapticNotify("error");
        setError(messageFromError(err));
        setCanRetry(true);
        refreshAfterFailure(taskId);
      } finally {
        runningRef.current = false;
        setRunning(false);
        setStage(null);
        setSteps([]);
        setStreamed("");
      }
    },
    [refreshAfterFailure],
  );

  // Re-run the last (failed) turn without retyping. The message is already
  // persisted, so this only re-issues the run — and it uses the CURRENT model,
  // so switching the picker then retrying continues the chat on another model.
  const retryTurn = useCallback(async () => {
    const taskId = taskIdRef.current;
    if (!taskId) return;
    const fileFirst = unfiledProjectRef.current ? projectFolderId : undefined;
    const turnAttachments = retryAttachmentsRef.current;
    const turnModel = resolveTurnModel({
      selectedModelId: model,
      models,
      hasImages: turnAttachments.some((entry) => entry.kind === "image"),
    });
    await runOwnTurn(
      taskId,
      async () => {
        if (fileFirst) {
          await assignSessionToFolder(taskId, fileFirst);
          unfiledProjectRef.current = false;
        }
        return agentLiteRun(
          taskId,
          turnModel || undefined,
          turnAttachments.length ? turnAttachments : undefined,
          effortFor(turnModel),
        );
      },
      turnAttachments,
    );
  }, [model, models, effortFor, runOwnTurn, projectFolderId]);

  // Stop the reply being written. The turn keeps what it had shown as the
  // answer and the pending run resolves with the stopped chat.
  const stopReply = useCallback(() => {
    const taskId = taskIdRef.current;
    if (!taskId) return;
    void agentLiteCancel(taskId).catch((err: unknown) => setError(messageFromError(err)));
  }, []);

  // Ask the last question again, on the model (and effort) selected now: the
  // way to compare an answer with another model's is to switch, then this.
  const regenerate = useCallback(() => {
    const taskId = taskIdRef.current;
    if (!taskId || runningRef.current) return;
    const turnModel = resolveTurnModel({ selectedModelId: model, models, hasImages: false });
    // The old answer leaves at once; the new one streams in where it was.
    setTask((current) =>
      current ? { ...current, messages: throughLastQuestion(current.messages) } : current,
    );
    void runOwnTurn(taskId, () =>
      agentLiteRegenerate(taskId, {
        model: turnModel || undefined,
        reasoningEffort: effortFor(turnModel),
      }),
    );
  }, [model, models, effortFor, runOwnTurn]);

  // "Branch from here": a new chat holding the thread up to this reply.
  const branchFrom = useCallback(
    (messageId: string) => {
      const sourceTaskId = taskIdRef.current;
      if (!sourceTaskId) return;
      void forkAgentTask({ sourceTaskId, upToMessageId: messageId })
        .then((forked) => {
          hapticNotify("success");
          // A branch of a temporary chat is temporary too (Rust copies the flag).
          if (isTemporaryChat(sourceTaskId)) markTemporaryChat(forked.id);
          onOpenSession?.(forked.id);
        })
        .catch((err: unknown) => setError(messageFromError(err)));
    },
    [onOpenSession],
  );

  const startEdit = useCallback((message: AgentMessageDto, last: boolean) => {
    setEditing({ messageId: message.id, last });
    setDraft(message.content);
    chatInputRef.current?.focus();
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setDraft("");
  }, []);

  // Send the edited question. The last one is rewritten here and answered
  // again; an earlier one opens as a new chat that is answered there.
  const submitEdit = useCallback(async () => {
    const edit = editing;
    const taskId = taskIdRef.current;
    const content = draft.trim();
    if (!edit || !taskId || (!content && attachments.length === 0) || runningRef.current) return;
    const stored = withAttachmentMarkers(content, attachments);
    const turnAttachments = attachments;
    const turnModel = resolveTurnModel({
      selectedModelId: model,
      models,
      hasImages: turnAttachments.some((entry) => entry.kind === "image"),
    });
    const request = {
      taskId,
      messageId: edit.messageId,
      content: stored,
      model: turnModel || undefined,
      attachments: turnAttachments.length ? turnAttachments : undefined,
      reasoningEffort: effortFor(turnModel),
    };
    setEditing(null);
    setDraft("");
    setAttachments([]);
    if (!edit.last) {
      setError(null);
      hapticImpact("light");
      try {
        const branch = await agentLiteEditBranch(request);
        if (isTemporaryChat(request.taskId)) markTemporaryChat(branch.id);
        hapticNotify("success");
        onOpenSession?.(branch.id);
      } catch (err) {
        hapticNotify("error");
        setError(messageFromError(err));
        // Nothing was written: give the edit back to the person.
        setEditing(edit);
        setDraft(content);
        setAttachments(turnAttachments);
      }
      return;
    }
    setTask((current) =>
      current
        ? { ...current, messages: rewrittenQuestion(current.messages, edit.messageId, stored) }
        : current,
    );
    await runOwnTurn(taskId, () => agentLiteEditLast(request), turnAttachments);
  }, [editing, draft, attachments, model, models, effortFor, onOpenSession, runOwnTurn]);

  // An empty chat, with nothing loading and nothing failed. Both the greeting
  // and the ambient ground key off this, so it is named rather than repeated.
  const showHero = !task?.messages.length && !running && !loadingTask && !taskLoadFailed;
  // Whether the opening's image is still on screen — true through its fade out,
  // which is longer than the greeting it replaces.
  const [ambientPresent, setAmbientPresent] = useState(showHero);

  const stageLabel = stageText(stage?.stage ?? "thinking");
  // A name a person reads ("GLM 5.3 Flash"), never the wire id: the catalog
  // reports the id as the name for most chat models.
  const activeModelLabel = model
    ? readableModelName(model, models.find((entry) => entry.id === model)?.name)
    : t("Default model");
  const hasDraft = Boolean(draft.trim()) || attachments.length > 0;
  const selectedModel = models.find((entry) => entry.id === model);
  const messages = task?.messages ?? [];
  const lastQuestion = lastQuestionIndex(messages);
  // "Default" has no catalog row of its own: read the window of the model
  // the backend will run the chat on.
  const gauge = readContextGauge({
    messages,
    draft,
    contextTokens: (selectedModel ?? models.find((entry) => entry.id === defaultModelId))
      ?.contextTokens,
  });
  const openers = suggestions(Boolean(onGenerateImage)).filter(
    (suggestion) => !hasDraft || suggestion.id === "image",
  );

  return (
    // data-ambient re-grounds the whole screen while the opening plays: the
    // light is dark whatever theme the app is in, so the header, the greeting
    // and the composer switch to on-ink tones for as long as it is there
    // (mobile.css). It is a hero section, and a hero section brings its own
    // ground with it.
    //
    // It follows the image's own presence rather than showHero, because the
    // image outlives the greeting by the length of its fade.
    <div
      className="mobile-screen-root mobile-chat"
      data-ambient={ambientPresent ? "true" : undefined}
    >
      <ChatAmbient active={showHero} onPresenceChange={setAmbientPresent} />
      <StackHeader
        // A new chat's opening has no title: the page is the question it asks.
        title={
          !task && showHero
            ? ""
            : temporary
              ? t("Temporary chat")
              : task?.title.trim() || t("New chat")
        }
        onBack={onBack}
        backLabel={t("Chats")}
        leading={
          onOpenHistory && !onBack ? (
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={t("Chat history")}
              onClick={onOpenHistory}
            >
              <IconBarsTwo size={20} />
            </button>
          ) : undefined
        }
        trailing={
          <>
            {credits && !showHero ? (
              // Compact form (no "credits" word): the pill shares the header
              // with the title and two buttons, unlike Studio's roomy one.
              <span className="mobile-credits-pill" aria-label={t("Available credits")}>
                {formatCredits(credits.availableCredits)}
              </span>
            ) : null}
            <ChatExportButton task={task} disabled={running} onError={setError} />
            {onOpenHistory && onBack ? (
              <button
                type="button"
                className="mobile-icon-button"
                aria-label={t("Chat history")}
                onClick={onOpenHistory}
              >
                <IconClock size={20} />
              </button>
            ) : null}
            {onNewChat ? (
              <button
                type="button"
                className="mobile-icon-button"
                aria-label={t("New chat")}
                disabled={running}
                onClick={onNewChat}
              >
                <IconBubblePlus size={20} />
              </button>
            ) : null}
          </>
        }
      />
      <div className="assistants-entry"></div>
      <div className="mobile-chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {loadingTask ? <Spinner aria-label={t("Loading")} /> : null}
        {!showHero ? <TemporaryChatBanner chatId={task?.id} /> : null}
        {showHero ? (
          <div className="mobile-chat-hero">
            <span className="mobile-chat-hero-mark" aria-hidden>
              <BrandMark />
            </span>
            <h2 className="mobile-chat-hero-greeting">{t("Ask a question")}</h2>
            <TemporaryChatToggle disabled={running} />
          </div>
        ) : null}
        {messages.map((message, index) => (
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
                  <ReplyActions
                    text={message.content}
                    conversationId={task?.id}
                    messageId={message.id}
                    onRegenerate={
                      !running && index === messages.length - 1 && lastQuestion >= 0
                        ? regenerate
                        : undefined
                    }
                    onBranch={!running && onOpenSession ? () => branchFrom(message.id) : undefined}
                  />
                  <MemorySourcesChip task={task} messageId={message.id} />
                </>
              )
            ) : (
              <>
                {message.content}
                {message.role === "user" && !running && !editing ? (
                  <QuestionActions onEdit={() => startEdit(message, index === lastQuestion)} />
                ) : null}
              </>
            )}
          </div>
        ))}
        {running && streamed ? (
          <div className="mobile-chat-bubble" data-role="assistant">
            <SimpleMarkdown text={streamed} streaming />
          </div>
        ) : null}
        {running && !streamed ? <ChatSteps steps={steps} fallback={stageLabel} /> : null}
        {error ? (
          <div className="mobile-chat-error" role="alert">
            <p className="mobile-dictation-error">{error}</p>
            {taskLoadFailed ? (
              <button type="button" className="mobile-chat-retry" onClick={() => void loadTask()}>
                {t("Try again")}
              </button>
            ) : canRetry ? (
              <button type="button" className="mobile-chat-retry" onClick={() => void retryTurn()}>
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
          onClick={jumpToLatest}
        >
          <IconArrowDown size={16} />
        </button>
      ) : null}
      <ChatComposer
        skills
        draft={draft}
        onDraftChange={setDraft}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        placeholder={t("Ask anything, privately…")}
        canSend={!running && !loadingTask && !taskLoadFailed}
        onSend={() => void (editing ? submitEdit() : send())}
        running={running}
        onStop={stopReply}
        onError={setError}
        inputRef={chatInputRef}
        above={
          editing ? (
            <div className="mobile-chat-editing">
              <span>
                {editing.last
                  ? t("Editing your message")
                  : t("Editing an earlier message opens a new chat")}
              </span>
              <button type="button" className="mobile-chat-editing-cancel" onClick={cancelEdit}>
                {t("Cancel")}
              </button>
            </div>
          ) : showHero && openers.length > 0 ? (
            // An empty chat with only a placeholder makes the user invent the
            // capability. These name what it can actually do: read a note in
            // full, look back over a week, make a picture, remember. Once
            // something is typed, only the picture stays: it takes the draft
            // with it, where the others would replace it.
            <fieldset className="mobile-chat-suggestions" aria-label={t("Suggestions")}>
              {openers.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className="mobile-chat-suggestion"
                  onClick={() => {
                    hapticSelection();
                    if (suggestion.id === "image") {
                      onGenerateImage?.(draft.trim());
                      return;
                    }
                    setDraft(suggestion.prompt);
                    chatInputRef.current?.focus();
                  }}
                >
                  {suggestion.icon}
                  {suggestion.label}
                </button>
              ))}
            </fieldset>
          ) : null
        }
        chip={
          <>
            <button
              type="button"
              className="mobile-composer-model"
              onClick={() => setPickerOpen(true)}
              aria-label={t("Choose model, {model}", { model: activeModelLabel })}
            >
              <IconSparklesSoft size={15} aria-hidden />
              <span className="mobile-composer-model-name">{activeModelLabel}</span>
              <IconChevronDownSmall size={14} aria-hidden />
            </button>
            <ComposerModes chatId={task?.id} draft={draft} compact />
            {messages.length > 0 ? <ContextGauge reading={gauge} onNewChat={onNewChat} /> : null}
          </>
        }
      />
      {pickerOpen ? (
        <ModelSheet
          title={t("Chat model")}
          entries={models.map((entry) => ({
            id: entry.id,
            name: readableModelName(entry.id, entry.name),
            keywords: [entry.name],
            subtitle:
              entry.supportsVision || entry.traits?.some((trait) => trait.includes("vision"))
                ? t("Vision · reads images")
                : undefined,
          }))}
          selectedId={model}
          defaultOption={{ label: t("Default"), subtitle: t("Recommended model") }}
          error={modelsError}
          onSelect={selectModel}
          onFork={task ? forkChat : undefined}
          extra={
            supportsReasoningEffort(selectedModel) ? (
              <ReasoningEffortRow value={effort} onChange={selectEffort} />
            ) : null
          }
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** Openers for an empty chat. Each one exercises a different tool, so the
 * first reply also teaches what the assistant reaches for. The label is the
 * short form on the chip; the prompt is what lands in the field. */
function suggestions(canMakeImages: boolean): {
  id: string;
  label: string;
  prompt: string;
  icon: ReactNode;
}[] {
  return [
    {
      id: "meeting",
      label: t("My last meeting"),
      prompt: t("Summarise my last meeting"),
      icon: <IconNoteText size={16} aria-hidden />,
    },
    {
      id: "week",
      label: t("My week"),
      prompt: t("What did I work on this week?"),
      icon: <IconCalendar2 size={16} aria-hidden />,
    },
    ...(canMakeImages
      ? [
          {
            id: "image",
            label: t("Generate an image"),
            prompt: "",
            icon: <IconImageSparkle size={16} aria-hidden />,
          },
        ]
      : []),
    {
      id: "remember",
      label: t("Remember a preference"),
      prompt: t("Remember that I prefer short replies"),
      icon: <IconBrain size={16} aria-hidden />,
    },
  ];
}

/** The thread up to and including its last question: what is left once the
 * replies to it are dropped to be asked for again. */
function throughLastQuestion(messages: AgentMessageDto[]): AgentMessageDto[] {
  const last = lastQuestionIndex(messages);
  return last < 0 ? messages : messages.slice(0, last + 1);
}

function lastQuestionIndex(messages: readonly AgentMessageDto[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

/** The thread with `messageId` rewritten to `content` and nothing after it. */
function rewrittenQuestion(
  messages: AgentMessageDto[],
  messageId: string,
  content: string,
): AgentMessageDto[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return messages;
  return [...messages.slice(0, index), { ...messages[index], content }];
}
