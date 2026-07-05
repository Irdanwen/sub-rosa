import { listen } from "@tauri-apps/api/event";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconPaperclip1 } from "central-icons/IconPaperclip1";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "../../../lib/errors";
import { hapticImpact, hapticNotify } from "../../../lib/haptics";
import { useKeyboardInset } from "../../../lib/keyboard-inset";
import { SimpleMarkdown } from "../../../lib/simple-markdown";
import { fetchMediaCatalog, modelsOfType } from "../../../lib/studio/catalog";
import type { MediaModel } from "../../../lib/studio/types";
import {
  AGENT_LITE_DONE_EVENT,
  AGENT_LITE_STATUS_EVENT,
  type AgentLiteAttachment,
  type AgentLiteStatusDto,
  type AgentTaskDto,
  agentLiteRun,
  assignSessionToFolder,
  createAgentTask,
  deleteAgentTask,
  getAgentTask,
  listAgentTasks,
  listSessionFolders,
  removeSessionFromFolder,
  sendAgentMessage,
  suggestAgentSessionTitle,
} from "../../../lib/tauri";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { EmptyState } from "../../ui/EmptyState";
import { ModelSheet } from "../ModelSheet";
import { StackHeader } from "../StackHeader";
import { SwipeableRow } from "../SwipeableRow";

const CHAT_MODEL_STORAGE_KEY = "subrosa:mobile:chat-model";

function storedChatModel(): string {
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
};

/** Session list for the mobile chat (agent-lite), with swipe to archive
 * (the shared Archive folder, via session_folders) or delete. */
export function AgentScreen({
  onOpenSession,
  ensureArchiveFolder,
  archiveFolderId,
}: AgentScreenProps) {
  const [tasks, setTasks] = useState<AgentTaskDto[]>([]);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<AgentTaskDto | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const refresh = useCallback(() => {
    listAgentTasks()
      .then((response) => setTasks(response.items))
      .catch(() => undefined);
    listSessionFolders()
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
  }, [archiveFolderId]);

  useEffect(() => {
    refresh();
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
        title="Chat"
        large
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
      <div className="mobile-list-scroll">
        {active.length === 0 && archived.length === 0 ? (
          <EmptyState
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
      </div>
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this chat?"
        description="The conversation and its messages are removed from this device."
        confirmLabel="Delete"
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
  onBack: () => void;
};

/** One chat thread: history + composer + live status while agent-lite runs. */
export function AgentSessionScreen({ sessionId, onBack }: AgentSessionScreenProps) {
  const [task, setTask] = useState<AgentTaskDto | null>(null);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<AgentLiteStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(storedChatModel);
  const [models, setModels] = useState<MediaModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<AgentLiteAttachment[]>([]);
  const taskIdRef = useRef<string | undefined>(sessionId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const keyboardInset = useKeyboardInset();

  useEffect(() => {
    if (!sessionId) return;
    getAgentTask(sessionId)
      .then(setTask)
      .catch((err: unknown) => setError(messageFromError(err)));
  }, [sessionId]);

  useEffect(() => {
    fetchMediaCatalog()
      .then((catalog) => setModels(modelsOfType(catalog, "text")))
      .catch((err: unknown) => setModelsError(messageFromError(err)));
  }, []);

  useEffect(() => {
    const unlistenStatus = listen<AgentLiteStatusDto>(AGENT_LITE_STATUS_EVENT, (event) => {
      if (event.payload.taskId === taskIdRef.current) setStage(event.payload);
    });
    const unlistenDone = listen<AgentTaskDto>(AGENT_LITE_DONE_EVENT, (event) => {
      if (event.payload.id !== taskIdRef.current) return;
      setTask(event.payload);
      setStage(null);
      setRunning(false);
    });
    return () => {
      void unlistenStatus.then((fn) => fn());
      void unlistenDone.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [task?.messages.length, stage]);

  const selectModel = useCallback((modelId: string) => {
    setModel(modelId);
    setPickerOpen(false);
    try {
      if (modelId) localStorage.setItem(CHAT_MODEL_STORAGE_KEY, modelId);
      else localStorage.removeItem(CHAT_MODEL_STORAGE_KEY);
    } catch {
      // Persistence is a nicety; the in-memory choice still applies.
    }
  }, []);

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
    setRunning(true);
    hapticImpact("light");
    try {
      let current = task;
      if (!current) {
        current = await createAgentTask({ prompt: stored, runPlaceholder: false });
        taskIdRef.current = current.id;
        setTask(current);
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
      const finished = await agentLiteRun(
        current.id,
        model || undefined,
        turnAttachments.length ? turnAttachments : undefined,
      );
      setTask(finished);
      hapticNotify("success");
    } catch (err) {
      hapticNotify("error");
      setError(messageFromError(err));
      if (taskIdRef.current) {
        getAgentTask(taskIdRef.current)
          .then(setTask)
          .catch(() => undefined);
      }
    } finally {
      setRunning(false);
      setStage(null);
    }
  }, [draft, attachments, running, task, model]);

  const stageLabel =
    stage?.stage === "searching-notes"
      ? "Searching your notes"
      : stage?.stage === "searching-web"
        ? "Searching the web"
        : "Thinking";
  const activeModelLabel = shortModelLabel(model) || "Model";

  return (
    <div className="mobile-screen-root mobile-chat">
      <StackHeader
        title={task?.title.trim() || "New chat"}
        onBack={onBack}
        backLabel="Chats"
        trailing={
          <button
            type="button"
            className="mobile-model-chip"
            onClick={() => setPickerOpen(true)}
            aria-label="Choose model"
          >
            {activeModelLabel}
          </button>
        }
      />
      <div className="mobile-chat-scroll" ref={scrollRef}>
        {task?.messages.map((message) => (
          <div key={message.id} className="mobile-chat-bubble" data-role={message.role}>
            {message.role === "assistant" ? (
              <SimpleMarkdown text={message.content} />
            ) : (
              message.content
            )}
          </div>
        ))}
        {running ? (
          <div className="mobile-chat-bubble mobile-chat-status" data-role="assistant">
            <span data-shimmer="true">
              {stageLabel}
              {stage?.detail ? ` : ${stage.detail}` : ""}...
            </span>
          </div>
        ) : null}
        {error ? <p className="mobile-dictation-error">{error}</p> : null}
      </div>
      <div className="mobile-chat-composer-stack" style={{ marginBottom: keyboardInset }}>
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
        <div className="mobile-chat-composer">
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
          <button
            type="button"
            className="mobile-icon-button"
            aria-label="Attach a file"
            onClick={() => attachInputRef.current?.click()}
          >
            <IconPaperclip1 size={18} />
          </button>
          <textarea
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
