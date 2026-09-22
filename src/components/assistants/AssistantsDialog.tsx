import { useKeyboardInset } from "../../lib/keyboard-inset";
import { listArtifacts } from "../../lib/studio/artifacts";
import type { StudioArtifact } from "../../lib/studio/types";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AssistantDefinition,
  type AssistantConversation,
  listAssistantArchive,
  getAssistantChatDefinition,
  getAssistantChat,
  type AssistantReference,
  type AssistantTool,
  addAssistantNote,
  addAssistantArtifact,
  deleteAssistant,
  deleteAssistantReference,
  duplicateAssistant,
  emptyAssistant,
  importAssistantReference,
  listAssistantReferences,
  listAssistants,
  prepareAssistantDraft,
  readAssistantReference,
  refreshAssistantNote,
  saveAssistant,
} from "../../lib/assistants";
import { useAccountSyncUpdated } from "../../lib/account-sync-events";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { useModalFocus } from "../../lib/modal-focus";
import {
  listNotes,
  listVeniceModels,
  type NoteListItemDto,
  type AgentTaskDto,
  type VeniceModelDto,
} from "../../lib/tauri";
import { BrandGradientMark } from "../brand/Marks";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { AssistantChat } from "./AssistantChat";
import { assistantQuestions, assistantTemplates } from "./templates";
import "./assistants.css";

export function AssistantsDialog({
  open,
  onClose,
  initialTaskId,
}: {
  open: boolean;
  onClose: () => void;
  initialTaskId?: string;
}) {
  if (!open) return null;
  return <AssistantsSurface onClose={onClose} initialTaskId={initialTaskId} />;
}

/**
 * The same library as a screen of its own: the phone's Assistants tab.
 *
 * On the phone the library was reachable only through a small "My assistants"
 * button inside Chat, a full-screen layer over the tab bar. As a tab it is
 * not a modal: nothing to close, no focus trap, and the tab bar stays.
 */
export function AssistantsScreen({ initialTaskId }: { initialTaskId?: string }) {
  return <AssistantsSurface embedded onClose={() => undefined} initialTaskId={initialTaskId} />;
}

type View = "library" | "create" | "edit" | "chat";
type Tab = "general" | "instructions" | "references" | "tools";

function AssistantsSurface({
  onClose,
  initialTaskId,
  embedded = false,
}: {
  onClose: () => void;
  initialTaskId?: string;
  /** Rendered as a tab's screen rather than as a layer over the app. */
  embedded?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const keyboardInset = useKeyboardInset();
  const [items, setItems] = useState<AssistantDefinition[]>([]);
  const [archive, setArchive] = useState<AssistantConversation[]>([]);
  const [initialTask, setInitialTask] = useState<AgentTaskDto | undefined>();
  const [view, setView] = useState<View>("library");
  const [draft, setDraft] = useState<AssistantDefinition>(emptyAssistant);
  const [saved, setSaved] = useState<AssistantDefinition | null>(null);
  const [tab, setTab] = useState<Tab>("general");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AssistantDefinition | null>(null);
  const [discardTarget, setDiscardTarget] = useState<"close" | "library" | null>(null);
  const [need, setNeed] = useState("");
  const [questionIndex, setQuestionIndex] = useState(-1);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [freeAnswers, setFreeAnswers] = useState<Record<string, string>>({});
  const [models, setModels] = useState<VeniceModelDto[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const dirty =
    view === "edit" && JSON.stringify(draft) !== JSON.stringify(saved ?? emptyAssistant());
  const close = () => {
    if (busy) return;
    if (dirty || (view === "create" && need.trim())) setDiscardTarget("close");
    else onClose();
  };
  useModalFocus(ref, { open: !embedded, onClose: close, lockScroll: true });
  const refresh = useCallback(async () => {
    const [definitions, conversations] = await Promise.all([
      listAssistants(),
      listAssistantArchive(),
    ]);
    setItems(definitions);
    setArchive(conversations);
  }, []);
  useEffect(() => {
    if (view !== "library") return;
    void refresh()
      .catch((err) => setError(messageFromError(err)))
      .finally(() => setLoading(false));
  }, [refresh, view]);
  useAccountSyncUpdated(refresh);
  useEffect(() => {
    void listVeniceModels("generation")
      .then((result) => setModels(result.models))
      .catch((err) => setModelsError(messageFromError(err)));
  }, []);

  useEffect(() => {
    if (!initialTaskId) return;
    let cancelled = false;
    setBusy(true);
    void Promise.all([getAssistantChat(initialTaskId), getAssistantChatDefinition(initialTaskId)])
      .then(([task, definition]) => {
        if (cancelled) return;
        setDraft(definition);
        setSaved(definition);
        setInitialTask(task);
        setView("chat");
      })
      .catch((err) => {
        if (!cancelled) setError(messageFromError(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialTaskId]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  }
  function edit(item: AssistantDefinition) {
    setDraft(item);
    setSaved(item);
    setInitialTask(undefined);
    setView("edit");
    setTab("general");
    setPreview(false);
  }
  function patch(value: Partial<AssistantDefinition>) {
    setDraft((previous) => ({ ...previous, ...value }));
  }
  function begin(prompt = "") {
    setNeed(prompt);
    setQuestionIndex(-1);
    setAnswers({});
    setFreeAnswers({});
    setView("create");
    setError(null);
  }
  const questions = assistantQuestions();
  const question = questions[questionIndex];
  async function generate() {
    await perform(async () => {
      const result = await prepareAssistantDraft(
        need,
        questions.map((entry) => ({
          question: entry.label,
          answer: [...(answers[entry.id] ?? []), freeAnswers[entry.id] ?? ""]
            .filter(Boolean)
            .join("; "),
        })),
      );
      setDraft({
        ...emptyAssistant(),
        name: result.name,
        description: result.description,
        instructions: result.instructions,
        opening_message: result.openingMessage,
        tools: result.tools,
      });
      setSaved(null);
      setView("edit");
      setTab("general");
      setPreview(false);
    });
  }
  const back = () => {
    if (dirty || (view === "create" && need.trim())) setDiscardTarget("library");
    else setView("library");
  };
  const save = () =>
    perform(async () => {
      const result = await saveAssistant(draft);
      setDraft(result);
      setSaved(result);
      await refresh();
    });

  return (
    <div
      className={embedded ? "assistants-embedded" : "assistants-backdrop"}
      style={embedded ? { paddingBottom: keyboardInset || undefined } : { bottom: keyboardInset }}
    >
      <div
        className="assistants-surface"
        data-view={view}
        ref={ref}
        // A layer is a dialog; a tab's screen is not.
        {...(embedded
          ? {}
          : { role: "dialog", "aria-modal": true, "aria-label": t("My assistants") })}
        tabIndex={-1}
      >
        <header className="assistants-header">
          <div className="assistants-header-start">
            {view !== "library" && (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={back}>
                {t("My assistants")}
              </button>
            )}
            <strong>
              {view === "library"
                ? t("My assistants")
                : view === "create"
                  ? t("Create your assistant")
                  : draft.name || t("New assistant")}
            </strong>
          </div>
          <div className="assistant-actions">
            {view === "edit" && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!saved || dirty || busy}
                  onClick={() => setPreview((value) => !value)}
                >
                  {preview ? t("Hide preview") : t("Preview")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !draft.name.trim() || !draft.instructions.trim() || !dirty}
                  onClick={() => void save()}
                >
                  {busy ? t("Saving…") : t("Save")}
                </button>
              </>
            )}
            {embedded ? null : (
              <button
                type="button"
                className="assistant-icon-button"
                disabled={busy}
                aria-label={t("Close")}
                onClick={close}
              >
                <IconCrossMedium size={20} />
              </button>
            )}
          </div>
        </header>
        {error && (
          <div className="assistant-error" role="alert">
            {error}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void perform(refresh)}
            >
              {t("Reload assistants")}
            </button>
          </div>
        )}
        {view === "library" && (
          <div className="assistants-library">
            <div className="assistants-hero">
              <BrandGradientMark />
              <h1>{t("An assistant for what matters to you")}</h1>
              <p>{t("Give it a purpose, your own instructions and the tools you choose.")}</p>
              <button type="button" className="btn btn-primary" onClick={() => begin()}>
                <IconPlusMedium size={16} />
                {t("Create an assistant")}
              </button>
            </div>
            {loading && <p role="status">{t("Loading")}</p>}
            {items.length > 0 && (
              <section aria-label={t("My assistants")} className="assistant-card-grid">
                {items.map((item) => (
                  <article className="assistant-card" key={item.id}>
                    <AssistantImage referenceId={item.avatar_ref} kind="avatar" />
                    <h2>{item.name}</h2>
                    <p>{item.description}</p>
                    <div className="assistant-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => {
                          setDraft(item);
                          setSaved(item);
                          setInitialTask(undefined);
                          setView("chat");
                        }}
                      >
                        {t("Chat")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() => edit(item)}
                      >
                        {t("Edit")}
                      </button>
                    </div>
                    <details>
                      <summary>{t("More options")}</summary>
                      <div className="assistant-actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const copy = await duplicateAssistant(item.id);
                              await refresh();
                              edit(copy);
                            })
                          }
                        >
                          {t("Duplicate")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() => setConfirmDelete(item)}
                        >
                          {t("Delete")}
                        </button>
                      </div>
                    </details>
                  </article>
                ))}
              </section>
            )}
            {archive.length > 0 && (
              <section className="assistant-template-section">
                <h2>{t("Previous conversations")}</h2>
                <div className="assistant-archive-list">
                  {archive.map((entry) => (
                    <button
                      type="button"
                      className="assistant-archive-item"
                      key={entry.task.id}
                      onClick={() => {
                        setDraft(entry.definition);
                        setSaved(entry.definition);
                        setInitialTask(entry.task);
                        setView("chat");
                      }}
                    >
                      <strong>{entry.task.title || entry.task.prompt}</strong>
                      <span>{entry.definition.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="assistant-template-section">
              <h2>{t("Start with an idea")}</h2>
              <div className="assistant-card-grid">
                {assistantTemplates().map((entry) => (
                  <button
                    type="button"
                    className="assistant-card assistant-template"
                    key={entry.id}
                    onClick={() => begin(entry.prompt)}
                  >
                    <span className="assistant-template-mark">
                      <BrandGradientMark />
                    </span>
                    <strong>{entry.name}</strong>
                    <span>{entry.description}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}
        {view === "create" && (
          <div className="assistant-creator">
            <div className="assistants-hero">
              <BrandGradientMark />
              <h1>{t("What would you like to create?")}</h1>
              <p>{t("Describe the help you want. A few answers will shape your assistant.")}</p>
            </div>
            <label className="assistant-field">
              <span>{t("Your idea")}</span>
              <textarea
                rows={4}
                value={need}
                disabled={busy}
                onChange={(event) => setNeed(event.target.value)}
                placeholder={t("An assistant that helps me…")}
              />
            </label>
            {questionIndex < 0 ? (
              <div className="assistant-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!need.trim()}
                  onClick={() => setQuestionIndex(0)}
                >
                  {t("Continue")}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setDraft(emptyAssistant());
                    setSaved(null);
                    setView("edit");
                  }}
                >
                  {t("Write instructions myself")}
                </button>
              </div>
            ) : (
              question && (
                <section className="assistant-question">
                  <div className="assistant-question-progress">
                    {t("Question {current} of {total}", {
                      current: questionIndex + 1,
                      total: questions.length,
                    })}
                  </div>
                  <fieldset disabled={busy}>
                    <legend>{question.label}</legend>
                    {question.options.map((option) => (
                      <label key={option} className="assistant-option">
                        <input
                          type={question.type === "multiple" ? "checkbox" : "radio"}
                          name={question.id}
                          checked={(answers[question.id] ?? []).includes(option)}
                          onChange={(event) =>
                            setAnswers((previous) => ({
                              ...previous,
                              [question.id]:
                                question.type === "single"
                                  ? [option]
                                  : event.target.checked
                                    ? [...(previous[question.id] ?? []), option]
                                    : (previous[question.id] ?? []).filter(
                                        (value) => value !== option,
                                      ),
                            }))
                          }
                        />
                        {option}
                      </label>
                    ))}
                    <label className="assistant-field">
                      <span>
                        {question.type === "text" ? t("Your answer") : t("Add your own answer")}
                      </span>
                      <textarea
                        rows={3}
                        value={freeAnswers[question.id] ?? ""}
                        onChange={(event) =>
                          setFreeAnswers((previous) => ({
                            ...previous,
                            [question.id]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </fieldset>
                  <div className="assistant-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setQuestionIndex((index) => index - 1)}
                    >
                      {t("Back")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() =>
                        questionIndex === questions.length - 1
                          ? void generate()
                          : setQuestionIndex((index) => index + 1)
                      }
                    >
                      {busy
                        ? t("Preparing your draft…")
                        : questionIndex === questions.length - 1
                          ? t("Prepare my draft")
                          : t("Next")}
                    </button>
                  </div>
                </section>
              )
            )}
          </div>
        )}
        {view === "edit" && (
          <div className="assistant-editor-layout" data-preview={preview}>
            <div className="assistant-editor">
              <nav className="assistant-tabs" aria-label={t("Assistant settings")}>
                {(
                  [
                    { id: "general", label: t("General") },
                    { id: "instructions", label: t("Instructions") },
                    { id: "references", label: t("References") },
                    { id: "tools", label: t("Tools") },
                  ] as const
                ).map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    aria-current={tab === entry.id ? "page" : undefined}
                    onClick={() => setTab(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </nav>
              <div className="assistant-editor-body">
                {dirty && (
                  <p className="assistant-muted">
                    {t("Save your changes before starting a preview.")}
                  </p>
                )}
                {tab === "general" && (
                  <>
                    <AssistantImage referenceId={draft.cover_ref} kind="cover" />
                    <AssistantImage referenceId={draft.avatar_ref} kind="avatar" />
                    <label className="assistant-field">
                      <span>{t("Name")}</span>
                      <input
                        value={draft.name}
                        maxLength={120}
                        onChange={(event) => patch({ name: event.target.value })}
                      />
                    </label>
                    <label className="assistant-field">
                      <span>{t("Description")}</span>
                      <textarea
                        rows={3}
                        value={draft.description}
                        onChange={(event) => patch({ description: event.target.value })}
                      />
                    </label>
                    <label className="assistant-field">
                      <span>{t("Opening message")}</span>
                      <textarea
                        rows={3}
                        value={draft.opening_message}
                        onChange={(event) => patch({ opening_message: event.target.value })}
                      />
                    </label>
                    <p className="assistant-muted">
                      {t("Choose an image from References for your avatar or cover.")}
                    </p>
                  </>
                )}
                {tab === "instructions" && (
                  <>
                    <label className="assistant-field">
                      <span>{t("Model")}</span>
                      <select
                        value={draft.model}
                        onChange={(event) => patch({ model: event.target.value })}
                      >
                        <option value="">{t("Default")}</option>
                        {draft.model && !models.some((model) => model.id === draft.model) && (
                          <option value={draft.model}>{draft.model}</option>
                        )}
                        {models.map((model) => (
                          <option value={model.id} key={model.id}>
                            {model.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {modelsError && (
                      <p className="assistant-error" role="alert">
                        {modelsError}
                      </p>
                    )}
                    <label className="assistant-field">
                      <span>{t("Instructions")}</span>
                      <textarea
                        className="assistant-instructions"
                        rows={18}
                        value={draft.instructions}
                        onChange={(event) => patch({ instructions: event.target.value })}
                      />
                    </label>
                    <p className="assistant-muted">
                      {t(
                        "Changes apply to new conversations. Existing conversations keep the version they started with.",
                      )}
                    </p>
                  </>
                )}
                {tab === "references" && (
                  <AssistantReferences
                    assistant={draft}
                    patch={patch}
                    onError={setError}
                    canDelete={!dirty}
                    onDeleted={async () => {
                      const fresh = (await listAssistants()).find((item) => item.id === draft.id);
                      if (fresh) {
                        setDraft(fresh);
                        setSaved(fresh);
                      }
                      await refresh();
                    }}
                  />
                )}
                {tab === "tools" && (
                  <>
                    <p className="assistant-muted">
                      {t(
                        "Choose what your assistant may use. Media generation always asks you to confirm before spending credits.",
                      )}
                    </p>
                    {toolOptions().map((tool) => (
                      <label className="assistant-option" key={tool.id}>
                        <input
                          type="checkbox"
                          checked={draft.tools.includes(tool.id)}
                          onChange={(event) =>
                            patch({
                              tools: event.target.checked
                                ? [...draft.tools, tool.id]
                                : draft.tools.filter((id) => id !== tool.id),
                            })
                          }
                        />
                        <span>
                          <strong>{tool.label}</strong>
                          <small>{tool.description}</small>
                        </span>
                      </label>
                    ))}
                    <hr />
                    <label className="assistant-option">
                      <input
                        type="checkbox"
                        checked={draft.allow_notes}
                        onChange={(event) => patch({ allow_notes: event.target.checked })}
                      />
                      <span>
                        <strong>{t("Access my notes")}</strong>
                        <small>{t("Search and read your notes when a request needs them.")}</small>
                      </span>
                    </label>
                    <label className="assistant-option">
                      <input
                        type="checkbox"
                        checked={draft.allow_memory}
                        onChange={(event) => patch({ allow_memory: event.target.checked })}
                      />
                      <span>
                        <strong>{t("Use my personal memory")}</strong>
                        <small>
                          {t(
                            "Recall and remember facts about you when Memory is enabled in settings.",
                          )}
                        </small>
                      </span>
                    </label>
                  </>
                )}
              </div>
            </div>
            {preview && saved && (
              <div className="assistant-preview">
                <AssistantChat key={saved.id} assistant={saved} />
              </div>
            )}
          </div>
        )}
        {view === "chat" && saved && (
          <AssistantChat
            key={initialTask?.id ?? saved.id}
            assistant={saved}
            initialTask={initialTask}
          />
        )}
        <ConfirmDialog
          open={confirmDelete !== null}
          onClose={() => setConfirmDelete(null)}
          title={t("Delete this assistant?")}
          description={t(
            "Your existing conversations remain available. The assistant and its references are removed.",
          )}
          confirmLabel={t("Delete")}
          destructive
          onConfirm={async () => {
            if (!confirmDelete) return;
            try {
              await deleteAssistant(confirmDelete);
              await refresh();
            } catch (err) {
              setError(messageFromError(err));
              setConfirmDelete(null);
              throw err;
            }
          }}
        />
        <ConfirmDialog
          open={discardTarget !== null}
          onClose={() => setDiscardTarget(null)}
          title={t("Discard your changes?")}
          description={t("Your unsaved draft will be lost.")}
          confirmLabel={t("Discard")}
          onConfirm={() => {
            if (discardTarget === "close") onClose();
            else {
              setView("library");
              setError(null);
            }
            setDiscardTarget(null);
          }}
        />
      </div>
    </div>
  );
}

function toolOptions(): { id: AssistantTool; label: string; description: string }[] {
  return [
    {
      id: "web",
      label: t("Web search"),
      description: t("Find current information and sources on the web."),
    },
    {
      id: "image",
      label: t("Images"),
      description: t("Propose images, edits and enlarged images."),
    },
    { id: "video", label: t("Video"), description: t("Propose video clips from your ideas.") },
    { id: "music", label: t("Music"), description: t("Propose songs and instrumental tracks.") },
    { id: "speech", label: t("Speech"), description: t("Propose spoken audio from your text.") },
  ];
}

function AssistantImage({
  referenceId,
  kind,
}: {
  referenceId: string | null;
  kind: "avatar" | "cover";
}) {
  const [data, setData] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    if (referenceId)
      void readAssistantReference(referenceId)
        .then((value) => {
          if (!cancelled) setData(value);
        })
        .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [referenceId]);
  if (!data)
    return kind === "avatar" ? (
      <span className="assistant-avatar-fallback">
        <BrandGradientMark />
      </span>
    ) : null;
  return (
    <img
      className={`assistant-${kind}`}
      src={data}
      alt={kind === "avatar" ? t("Assistant avatar") : t("Assistant cover")}
    />
  );
}

function AssistantReferences({
  assistant,
  patch,
  onError,
  canDelete,
  onDeleted,
}: {
  canDelete: boolean;
  onDeleted: () => Promise<void>;
  assistant: AssistantDefinition;
  patch: (value: Partial<AssistantDefinition>) => void;
  onError: (error: string | null) => void;
}) {
  const [references, setReferences] = useState<AssistantReference[]>([]);
  const [notes, setNotes] = useState<NoteListItemDto[]>([]);
  const [gallery, setGallery] = useState<StudioArtifact[] | null>(null);
  const [artifactName, setArtifactName] = useState("");
  const [noteId, setNoteId] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AssistantReference | null>(null);
  const refresh = useCallback(async () => {
    if (assistant.id) setReferences(await listAssistantReferences(assistant.id));
  }, [assistant.id]);
  useEffect(() => {
    void refresh().catch((err) => onError(messageFromError(err)));
  }, [refresh, onError]);
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      onError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  }
  if (!assistant.id)
    return <p className="assistant-muted">{t("Save your assistant before adding references.")}</p>;
  return (
    <>
      <p className="assistant-muted">
        {t(
          "Add text, PDF, images or Office documents. Notes are dated copies that you can refresh.",
        )}
      </p>
      <div className="assistant-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void run(() => importAssistantReference(assistant.id))}
        >
          {t("Add a file")}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setNotes((await listNotes()).items);
            })
          }
        >
          {t("Choose a note")}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          {t("Refresh")}
        </button>
      </div>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setGallery(await listArtifacts("image"));
          })
        }
      >
        {t("Choose from your gallery")}
      </button>
      {gallery !== null &&
        (gallery.length === 0 ? (
          <p className="assistant-muted">
            {t("Your gallery has no images yet. Create one in a conversation, then return here.")}
          </p>
        ) : (
          <div className="assistant-actions">
            <label className="assistant-field">
              <span>{t("Gallery image")}</span>
              <select
                value={artifactName}
                onChange={(event) => setArtifactName(event.target.value)}
              >
                <option value="">{t("Choose an image")}</option>
                {gallery.map((artifact) => (
                  <option key={artifact.id} value={artifact.fileName}>
                    {artifact.prompt || artifact.fileName}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!artifactName || busy}
              onClick={() =>
                void run(async () => {
                  await addAssistantArtifact(assistant.id, artifactName);
                  setArtifactName("");
                })
              }
            >
              {t("Add reference")}
            </button>
          </div>
        ))}
      {notes.length > 0 && (
        <div className="assistant-actions">
          <label className="assistant-field">
            <span>{t("Note")}</span>
            <select value={noteId} onChange={(event) => setNoteId(event.target.value)}>
              <option value="">{t("Choose a note")}</option>
              {notes.map((note) => (
                <option key={note.id} value={note.id}>
                  {note.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!noteId || busy}
            onClick={() =>
              void run(async () => {
                await addAssistantNote(assistant.id, noteId);
                setNoteId("");
              })
            }
          >
            {t("Add reference")}
          </button>
        </div>
      )}
      {references.length === 0 && (
        <div className="assistant-reference-empty">
          <h3>{t("No references yet")}</h3>
          <p>{t("Give your assistant the documents that matter to your work.")}</p>
        </div>
      )}
      <ul className="assistant-reference-list">
        {references.map((reference) => (
          <li key={reference.id}>
            <div>
              <strong>{reference.name}</strong>
              <small>
                {reference.status === "ready"
                  ? t("Ready")
                  : reference.status === "failed"
                    ? t("Couldn't read this file")
                    : t("Preparing…")}
              </small>
              {reference.error && <p className="assistant-error">{reference.error}</p>}
            </div>
            <div className="assistant-actions">
              {reference.status === "ready" &&
                /^(image|png|jpg|jpeg|webp|gif|avif|heic)/i.test(reference.format) && (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => patch({ avatar_ref: reference.id })}
                    >
                      {t("Use as avatar")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => patch({ cover_ref: reference.id })}
                    >
                      {t("Use as cover")}
                    </button>
                  </>
                )}
              {reference.note_id && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void run(() => refreshAssistantNote(reference.id))}
                >
                  {t("Refresh note copy")}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !canDelete}
                onClick={() => setConfirmDelete(reference)}
              >
                {t("Remove")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {(assistant.avatar_ref || assistant.cover_ref) && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => patch({ avatar_ref: null, cover_ref: null })}
        >
          {t("Clear profile images")}
        </button>
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={t("Remove this reference?")}
        description={t(
          "New conversations and conversations you explicitly update will no longer use this reference. Existing conversations keep their saved copy.",
        )}
        confirmLabel={t("Remove")}
        destructive
        onConfirm={async () => {
          if (!confirmDelete) return;
          try {
            await deleteAssistantReference(confirmDelete.id);
            await onDeleted();
            await refresh();
          } catch (err) {
            onError(messageFromError(err));
            setConfirmDelete(null);
            throw err;
          }
        }}
      />
    </>
  );
}
