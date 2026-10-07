import "../../styles/projects.css";
import { IconFileText } from "central-icons/IconFileText";
import { IconPaperclip1 } from "central-icons/IconPaperclip1";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useId, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  PROJECT_FILE_ACCEPT,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_MEMORY_MODES,
  type ProjectFile,
  type ProjectMemoryMode,
  type ProjectSettings,
  projectFileAdd,
  projectFileDelete,
  projectFileStatus,
  projectGet,
  projectSave,
} from "../../lib/projects";
import type { FolderDto } from "../../lib/tauri";
import { Dialog, DialogField } from "../ui/Dialog";

type ProjectSettingsDialogProps = {
  open: boolean;
  onClose: () => void;
  folder: FolderDto;
};

/**
 * A project's settings on the desktop (ADR-0085): the instructions its chats
 * follow, the files they can search, and whether it keeps its memory apart.
 * Files are stored as soon as they are picked; the instructions and the
 * memory mode wait for Save.
 */
export function ProjectSettingsDialog({ open, onClose, folder }: ProjectSettingsDialogProps) {
  const [saved, setSaved] = useState<ProjectSettings | null>(null);
  const [instructions, setInstructions] = useState("");
  const [memoryMode, setMemoryMode] = useState<ProjectMemoryMode>("default");
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const counterId = useId();

  // Every opening starts from the stored project: nothing of another folder,
  // or of an edit abandoned with Cancel, shows while it loads.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSaved(null);
    setInstructions("");
    setMemoryMode("default");
    setFiles([]);
    setRemoving(new Set());
    setLoadFailed(false);
    setError(null);
    // `attempt` changes only to load again after a failure (Try again).
    void attempt;
    projectGet(folder.id)
      .then((project) => {
        if (cancelled) return;
        setSaved(project.settings);
        setInstructions(project.settings.instructions);
        setMemoryMode(project.settings.memoryMode);
        setFiles(project.files);
      })
      .catch((caught) => {
        if (cancelled) return;
        setLoadFailed(true);
        setError(messageFromError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [open, folder.id, attempt]);

  async function addFiles(picked: File[]) {
    setAdding(true);
    setError(null);
    const failed: string[] = [];
    for (const file of picked) {
      try {
        const added = await projectFileAdd(folder.id, file);
        setFiles((current) => [...current, added]);
      } catch (caught) {
        failed.push(
          t("{name} was not added. {reason}", {
            name: file.name,
            reason: messageFromError(caught),
          }),
        );
      }
    }
    if (failed.length > 0) setError(failed.join(" "));
    setAdding(false);
  }

  async function removeFile(id: string) {
    if (removing.has(id)) return;
    setError(null);
    setRemoving((current) => new Set(current).add(id));
    try {
      await projectFileDelete(id);
      setFiles((current) => current.filter((file) => file.id !== id));
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setRemoving((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || saved === null) return;
    setBusy(true);
    setError(null);
    try {
      await projectSave({ folderId: folder.id, instructions, memoryMode });
      onClose();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  const loading = saved === null && !loadFailed;
  const editable = saved !== null && !busy;
  const over = instructions.length > PROJECT_INSTRUCTIONS_MAX_CHARS;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      title={t("Project settings")}
      description={t("What chats in {name} should know and remember.", { name: folder.name })}
      initialFocusSelector='textarea[name="project-instructions"]'
      width={560}
      footer={
        <>
          <button type="button" className="primary-action" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button
            type="submit"
            form="project-settings-form"
            className="primary-action primary-solid"
            disabled={busy || saved === null || over}
          >
            {busy ? t("Saving…") : t("Save")}
          </button>
        </>
      }
    >
      <form
        id="project-settings-form"
        className="dialog-body"
        aria-busy={loading || undefined}
        onSubmit={handleSubmit}
      >
        {loading ? (
          <p className="dialog-field-hint" role="status">
            {t("Loading the project…")}
          </p>
        ) : null}
        <DialogField
          label={t("Instructions")}
          htmlFor="project-instructions"
          hint={t("Chats in this project follow these, on top of your personalization.")}
        >
          {/* Read-only rather than disabled while it loads, so the dialog's
              first focus still lands here. */}
          <textarea
            id="project-instructions"
            name="project-instructions"
            className="dialog-textarea"
            aria-describedby={counterId}
            placeholder={t(
              "e.g. We are planning the spring launch. Answer in French, keep it short.",
            )}
            value={instructions}
            onChange={(event) => setInstructions(event.currentTarget.value)}
            readOnly={!editable}
            rows={5}
          />
          <span id={counterId} className="project-counter" data-over={over || undefined}>
            {t("{count} of {max}", {
              count: instructions.length,
              max: PROJECT_INSTRUCTIONS_MAX_CHARS,
            })}
          </span>
        </DialogField>

        <fieldset className="project-memory-modes">
          <legend className="dialog-field-label">{t("Memory")}</legend>
          {PROJECT_MEMORY_MODES.map((mode) => (
            <label
              key={mode.id}
              className="project-memory-mode"
              data-active={memoryMode === mode.id || undefined}
            >
              <input
                type="radio"
                name="project-memory-mode"
                value={mode.id}
                checked={memoryMode === mode.id}
                disabled={!editable}
                onChange={() => setMemoryMode(mode.id)}
              />
              <span className="project-memory-mode-text">
                <span className="project-memory-mode-label">{mode.label}</span>
                <span className="project-memory-mode-detail">{mode.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="dialog-field">
          <div className="project-files-header">
            <span className="dialog-field-label">{t("Files")}</span>
            <button
              type="button"
              className="primary-action"
              disabled={adding || saved === null}
              onClick={() => fileInput.current?.click()}
            >
              <IconPaperclip1 size={14} aria-hidden />
              {adding ? t("Adding…") : t("Add files")}
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={PROJECT_FILE_ACCEPT}
            multiple
            hidden
            onChange={(event) => {
              const picked = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (picked.length > 0) void addFiles(picked);
            }}
          />
          {saved === null ? null : files.length === 0 ? (
            <p className="dialog-field-hint">
              {t(
                "Add PDFs, Office documents, text or images. Chats in this project can search them.",
              )}
            </p>
          ) : (
            <ul className="project-files">
              {files.map((file) => (
                <li key={file.id} className="project-file" data-status={file.status}>
                  <IconFileText size={14} aria-hidden />
                  <span className="project-file-name">{file.name}</span>
                  <span className="project-file-status">
                    {removing.has(file.id) ? t("Removing…") : projectFileStatus(file)}
                  </span>
                  <button
                    type="button"
                    className="ghost-icon-button"
                    aria-label={t("Remove {name}", { name: file.name })}
                    disabled={removing.has(file.id)}
                    onClick={() => void removeFile(file.id)}
                  >
                    <IconTrashCan size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error ? (
          <p className="dialog-share-error" role="alert">
            {error}
          </p>
        ) : null}
        {loadFailed ? (
          <button
            type="button"
            className="primary-action"
            onClick={() => setAttempt((count) => count + 1)}
          >
            {t("Try again")}
          </button>
        ) : null}
      </form>
    </Dialog>
  );
}
