import { type ReactNode, useCallback, useMemo, useState } from "react";
import type { Account } from "../../lib/api";
import type { BlockRenderer } from "../../lib/chat-blocks";
import { t } from "../../lib/i18n";
import type { TurnExtension } from "../agent";
import { conversationSnapshot, getAssistant, startAssistantChat } from "../assistants";
import {
  type Attachment,
  hasAttachmentMarkers,
  visionModelFor,
  withAttachmentMarkers,
} from "../attachments";
import type { LiveModel, Operator } from "../carpe-diem";
import { type Chat, createChat, type Message, titleFromPrompt } from "../library";
import type { LocalState } from "../local";
import type { ChatModel } from "../models";
import { getProject, listProjects, moveChatToProject, projectIdOfChat } from "../projects";
import { isSaved, replySaveRequest, saveItem } from "../saved";
import type { SyncClient } from "../sync";
import { planTurn } from "../turn-plan";
import { AssistantsView } from "./AssistantsView";
import { AttachmentBar } from "./AttachmentBar";
import { CanvasPane } from "./CanvasPane";
import { blockRenderer } from "./ChatBlocks";
import type { ClientContext } from "./context";
import { ImagesView } from "./ImagesView";
import { LibraryView } from "./LibraryView";
import { MemoryManager } from "./MemoryManager";
import { ProjectsView } from "./ProjectsView";
import { PublishingView } from "./PublishingView";
import { ShareDialog } from "./ShareDialog";
import "./workspace.css";

export type View = "chat" | "projects" | "assistants" | "images" | "library" | "publishing";

const VIEWS: [View, () => string][] = [
  ["projects", () => t("Projects", "Projets")],
  ["assistants", () => t("Assistants", "Assistants")],
  ["images", () => t("Pictures", "Images")],
  ["library", () => t("Library", "Bibliothèque")],
  ["publishing", () => t("Publishing", "Publication")],
];

/**
 * Everything WP20 adds to the web client around the chat, in one place so
 * the chat itself (`WebClient.tsx`) only plugs it in: the views beside the
 * chat (projects, assistants, pictures, library, publishing), the composer's
 * attachments, the chat header's share and project controls, the canvas, the
 * cards with actions, saving a reply, and what a turn adds to agent-lite's
 * (`turn-plan.ts`).
 */
export function useWorkspace(input: {
  account: Account;
  vaultKey: Uint8Array<ArrayBuffer>;
  sync: SyncClient | null;
  local: LocalState | null;
  operator: Operator;
  openKey: () => Promise<string | null>;
  models: ChatModel[];
  live: LiveModel[];
  model: string;
  memoryOn: boolean;
  pastChats: boolean;
  flush: () => void;
  /** The chat on screen: an id, null for a new chat, "temporary". */
  chatId: string | null | "temporary";
  openChat: (id: string | null) => void;
}) {
  const { sync, chatId, flush, openChat } = input;
  const [view, setView] = useState<View>("chat");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [canvas, setCanvas] = useState<{ noteId: string; proposal: string | null } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [garment, setGarment] = useState<string | undefined>(undefined);
  const [newChat, setNewChat] = useState<{ projectId?: string; assistantId?: string }>({});
  const [, setSaved] = useState(0);

  const ctx: ClientContext | null = useMemo(
    () =>
      sync
        ? {
            account: input.account,
            vaultKey: input.vaultKey,
            sync,
            local: input.local,
            operator: input.operator,
            openKey: input.openKey,
            models: input.models,
            live: input.live,
            model: input.model,
            flush,
            openChat: (id) => {
              setView("chat");
              openChat(id);
            },
          }
        : null,
    [
      sync,
      input.account,
      input.vaultKey,
      input.local,
      input.operator,
      input.openKey,
      input.models,
      input.live,
      input.model,
      flush,
      openChat,
    ],
  );

  const realChat = chatId && chatId !== "temporary" ? chatId : null;
  const snapshot = sync && realChat ? conversationSnapshot(sync, realChat) : null;
  const pendingAssistant =
    sync && !chatId && newChat.assistantId ? getAssistant(sync, newChat.assistantId) : null;

  /** The model a turn runs on: an assistant's own, else the chosen one; an
   * image turn on a model that reads none moves to one as private, or is
   * refused. */
  const turnModel = useCallback(
    (hasImages: boolean): { model: string } | { error: string } => {
      const base = snapshot?.definition.model || pendingAssistant?.model || input.model;
      if (!hasImages) return { model: base };
      const vision = visionModelFor(input.models, base);
      return vision
        ? { model: vision }
        : {
            error: t(
              "No model as private as this one can read pictures. Choose a model that reads images, or send the text alone.",
              "Aucun modèle aussi confidentiel que celui-ci ne lit les images. Choisissez un modèle qui lit les images, ou envoyez le texte seul.",
            ),
          };
    },
    [snapshot, pendingAssistant, input.model, input.models],
  );

  /** Creates the chat a first message opens: an assistant's conversation
   * with its snapshot (which writes the question too), or a plain chat,
   * filed in the project it was started from. */
  const createFor = useCallback(
    async (
      content: string,
      model: string | null,
      title?: string,
    ): Promise<{ id: string; written: boolean }> => {
      if (!sync) throw new Error("Not ready.");
      if (newChat.assistantId) {
        const id = await startAssistantChat(sync, newChat.assistantId, content);
        setNewChat({});
        return { id, written: true };
      }
      // Titled by what was asked, not by the names of the files.
      const id = await createChat(
        sync,
        content,
        model,
        title?.trim() ? titleFromPrompt(title) : undefined,
      );
      if (newChat.projectId) await moveChatToProject(sync, id, newChat.projectId);
      setNewChat({});
      return { id, written: false };
    },
    [sync, newChat],
  );

  /** What this turn adds to agent-lite's, and clears the attachments it
   * carries. */
  const plan = useCallback(
    (turnChat: string | null, history: Message[]): TurnExtension | undefined => {
      if (!sync) return undefined;
      const project =
        turnChat && !snapshot ? getProject(sync, projectIdOfChat(sync, turnChat) ?? "") : null;
      const extension = planTurn({
        sync,
        chatId: turnChat,
        history,
        memory: input.memoryOn,
        pastChats: input.pastChats,
        project,
        assistant: turnChat ? conversationSnapshot(sync, turnChat) : null,
        attachments,
      });
      setAttachments([]);
      return extension;
    },
    [sync, snapshot, input.memoryOn, input.pastChats, attachments],
  );

  const renderBlock: BlockRenderer | undefined = sync
    ? blockRenderer(sync, realChat, {
        onCanvas: (noteId, proposal) => setCanvas({ noteId, proposal }),
        onTryOn: (named) => {
          setGarment(named ?? "");
          setView("images");
        },
        onSave: (request) => {
          void saveItem(sync, request).then(() => {
            setSaved((value) => value + 1);
            flush();
          });
        },
        isSaved: (key) => isSaved(sync, key),
      })
    : undefined;

  const replyAction = (message: Message): ReactNode => {
    if (!sync || !realChat || message.role !== "assistant") return null;
    const request = replySaveRequest({
      text: message.content,
      conversationId: realChat,
      messageId: message.id,
    });
    const saved = isSaved(sync, request.sourceKey);
    return (
      <button
        type="button"
        aria-pressed={saved}
        disabled={saved}
        onClick={() =>
          void saveItem(sync, request).then(() => {
            setSaved((value) => value + 1);
            flush();
          })
        }
      >
        {saved
          ? t("Saved to library", "Enregistré dans la bibliothèque")
          : t("Save to library", "Enregistrer dans la bibliothèque")}
      </button>
    );
  };

  const nav = (
    <nav className="wc-views" aria-label={t("More", "Plus")}>
      <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}>
        {t("Chat", "Discussion")}
      </button>
      {VIEWS.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>
          {label()}
        </button>
      ))}
    </nav>
  );

  const mainView: ReactNode =
    !ctx || view === "chat" ? null : view === "projects" ? (
      <ProjectsView
        ctx={ctx}
        onNewChat={(projectId) => {
          setNewChat({ projectId });
          setView("chat");
          openChat(null);
        }}
      />
    ) : view === "assistants" ? (
      <AssistantsView
        ctx={ctx}
        onStart={(assistantId) => {
          setNewChat({ assistantId });
          setView("chat");
          openChat(null);
        }}
      />
    ) : view === "images" ? (
      <ImagesView ctx={ctx} garment={garment} />
    ) : view === "library" ? (
      <LibraryView ctx={ctx} />
    ) : (
      <PublishingView ctx={ctx} />
    );

  const headerControls = (current: Chat | undefined, messages: Message[]): ReactNode => {
    if (!sync || !current) return null;
    const projectId = projectIdOfChat(sync, current.id) ?? "";
    return (
      <>
        {!current.assistant && (
          <label>
            <span className="sr-only">{t("Project", "Projet")}</span>
            <select
              value={projectId}
              onChange={(event) =>
                void moveChatToProject(sync, current.id, event.target.value || null).then(flush)
              }
            >
              <option value="">{t("No project", "Aucun projet")}</option>
              {listProjects(sync).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="button"
          type="button"
          disabled={!messages.length}
          onClick={() => setShareOpen(true)}
        >
          {t("Share link", "Lien de partage")}
        </button>
        <ShareDialog
          open={shareOpen}
          title={current.title}
          messages={messages}
          onClose={() => setShareOpen(false)}
        />
      </>
    );
  };

  const startingNotice: ReactNode =
    sync && !chatId && (newChat.projectId || pendingAssistant) ? (
      <p className="notice">
        {pendingAssistant
          ? pendingAssistant.opening_message ||
            pendingAssistant.description ||
            t(
              `A new chat with ${pendingAssistant.name}.`,
              `Une nouvelle discussion avec ${pendingAssistant.name}.`,
            )
          : t(
              `This new chat will be in the project ${getProject(sync, newChat.projectId ?? "")?.name ?? ""}.`,
              `Cette nouvelle discussion sera dans le projet ${getProject(sync, newChat.projectId ?? "")?.name ?? ""}.`,
            )}
      </p>
    ) : null;

  return {
    view,
    nav,
    mainView,
    attachments,
    /** The question as it is stored: the text and one marker per file. */
    stored: (text: string) => withAttachmentMarkers(text, attachments),
    composer: (disabled: boolean) => (
      <AttachmentBar attachments={attachments} onChange={setAttachments} disabled={disabled} />
    ),
    canvasPane:
      ctx && canvas ? (
        <CanvasPane
          ctx={ctx}
          noteId={canvas.noteId}
          proposal={canvas.proposal}
          onClose={() => setCanvas(null)}
        />
      ) : null,
    renderBlock,
    replyAction,
    headerControls,
    startingNotice,
    /** A custom assistant's conversation that has its snapshot continues
     * here; one without fails closed and is only read. */
    continuable: (current: Chat | undefined) => !current?.assistant || !!snapshot,
    /** An assistant chat reads memory only when the assistant may. */
    memoryFor: (memoryOn: boolean) =>
      memoryOn &&
      (snapshot || pendingAssistant
        ? !!(snapshot?.definition.allow_memory ?? pendingAssistant?.allow_memory)
        : true),
    turnModel,
    createFor,
    plan,
    interrupted: (message: Message) =>
      message.role === "user" && hasAttachmentMarkers(message.content),
    memoryManager: sync ? <MemoryManager sync={sync} onChanged={flush} /> : null,
    resetNewChat: () => setNewChat({}),
  };
}
