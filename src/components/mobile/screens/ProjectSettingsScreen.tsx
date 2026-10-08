import "../../../styles/projects.css";
import { useEffect, useId, useRef, useState } from "react";
import { messageFromError } from "../../../lib/errors";
import { hapticNotify } from "../../../lib/haptics";
import { t } from "../../../lib/i18n";
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
} from "../../../lib/projects";
import type { FolderDto } from "../../../lib/tauri";
import { ShareProjectButton } from "../../spaces/ShareProjectButton";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SettingsActionRow, SettingsGroup, SettingsRow } from "../SettingsList";
import { StackHeader } from "../StackHeader";
import { SwipeableRow } from "../SwipeableRow";

/**
 * A project's settings on the phone (ADR-0085): the instructions its chats
 * follow, the files they can search, and whether it keeps its memory apart.
 * The phone rebuilds a chat's prompt every turn, so a change applies from the
 * next message.
 */
export function ProjectSettingsScreen({
  folder,
  onBack,
}: {
  folder?: FolderDto;
  onBack: () => void;
}) {
  const [saved, setSaved] = useState<ProjectSettings | null>(null);
  const [instructions, setInstructions] = useState("");
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProjectFile | null>(null);
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const counterId = useId();
  const folderId = folder?.id;

  useEffect(() => {
    if (!folderId) return;
    let cancelled = false;
    // `attempt` changes only to load again after a failure (Try again).
    void attempt;
    setLoadFailed(false);
    setError(null);
    projectGet(folderId)
      .then((project) => {
        if (cancelled) return;
        setSaved(project.settings);
        setInstructions(project.settings.instructions);
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
  }, [folderId, attempt]);

  /** Stores the settings. Switching the memory mode saves the instructions
   * as stored, and leaves what is being typed in the field alone. */
  async function save(next: { instructions: string; memoryMode: ProjectMemoryMode }) {
    if (!folderId) return;
    setSaving(true);
    try {
      const stored = await projectSave({ folderId, ...next });
      setSaved(stored);
      setInstructions((typed) => (typed === next.instructions ? stored.instructions : typed));
      setError(null);
      hapticNotify("success");
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSaving(false);
    }
  }

  async function addFiles(picked: File[]) {
    if (!folderId) return;
    setAdding(true);
    setError(null);
    const failed: string[] = [];
    for (const file of picked) {
      try {
        const added = await projectFileAdd(folderId, file);
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

  async function removeFile(file: ProjectFile) {
    if (removingIds.has(file.id)) return;
    setError(null);
    setRemovingIds((current) => new Set(current).add(file.id));
    try {
      await projectFileDelete(file.id);
      setFiles((current) => current.filter((item) => item.id !== file.id));
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setRemovingIds((current) => {
        const next = new Set(current);
        next.delete(file.id);
        return next;
      });
    }
  }

  const over = instructions.length > PROJECT_INSTRUCTIONS_MAX_CHARS;
  const dirty = saved !== null && instructions !== saved.instructions;
  const loading = folderId !== undefined && saved === null && !loadFailed;

  if (!folder) {
    return (
      <div className="mobile-screen-root">
        <StackHeader title={t("Project settings")} onBack={onBack} backLabel={t("Folder")} />
        <div className="mobile-settings-scroll">
          <p className="mobile-memory-error" role="alert">
            {t("This project no longer exists.")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-screen-root">
      <StackHeader title={t("Project settings")} onBack={onBack} backLabel={folder.name} />
      <div className="mobile-settings-scroll" aria-busy={loading || undefined}>
        {loading ? (
          <p className="project-mobile-status" role="status">
            {t("Loading the project…")}
          </p>
        ) : null}
        {loadFailed ? (
          <SettingsGroup>
            <SettingsActionRow label={t("Try again")} onClick={() => setAttempt((n) => n + 1)} />
          </SettingsGroup>
        ) : null}
        <SettingsGroup
          title={t("Instructions")}
          footer={t("Chats in this project follow these from their next message.")}
        >
          <SettingsRow align="stack">
            <div className="project-mobile-field">
              <textarea
                id={fieldId}
                aria-label={t("Instructions")}
                aria-describedby={counterId}
                value={instructions}
                placeholder={t(
                  "e.g. We are planning the spring launch. Answer in French, keep it short.",
                )}
                disabled={saved === null}
                onChange={(event) => setInstructions(event.currentTarget.value)}
              />
              <span id={counterId} className="project-counter" data-over={over || undefined}>
                {t("{count} of {max}", {
                  count: instructions.length,
                  max: PROJECT_INSTRUCTIONS_MAX_CHARS,
                })}
              </span>
            </div>
          </SettingsRow>
          <SettingsRow align="stack">
            <button
              type="button"
              className="project-mobile-save"
              disabled={!dirty || saving || over}
              onClick={() => saved && void save({ instructions, memoryMode: saved.memoryMode })}
            >
              {saving && dirty ? t("Saving…") : t("Save instructions")}
            </button>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title={t("Memory")}>
          {PROJECT_MEMORY_MODES.map((mode) => (
            <label
              key={mode.id}
              className="project-memory-mode"
              data-active={saved?.memoryMode === mode.id || undefined}
            >
              <input
                type="radio"
                name="project-memory-mode"
                value={mode.id}
                checked={saved?.memoryMode === mode.id}
                disabled={saved === null || saving}
                onChange={() =>
                  saved && void save({ instructions: saved.instructions, memoryMode: mode.id })
                }
              />
              <span className="project-memory-mode-text">
                <span className="project-memory-mode-label">{mode.label}</span>
                <span className="project-memory-mode-detail">{mode.detail}</span>
              </span>
            </label>
          ))}
        </SettingsGroup>

        <SettingsGroup
          title={t("Files")}
          footer={t(
            "Add PDFs, Office documents, text or images. Chats in this project can search them.",
          )}
        >
          {files.map((file) => (
            <SwipeableRow
              key={file.id}
              actions={[
                { label: t("Remove"), tone: "destructive", onAction: () => setRemoving(file) },
              ]}
            >
              <SettingsRow
                label={file.name}
                detail={
                  <span className="project-mobile-file-status" data-status={file.status}>
                    {removingIds.has(file.id) ? t("Removing…") : projectFileStatus(file)}
                  </span>
                }
              />
            </SwipeableRow>
          ))}
          {saved !== null && files.length === 0 ? <SettingsRow label={t("No files yet")} /> : null}
          <SettingsActionRow
            label={adding ? t("Adding…") : t("Add files")}
            disabled={adding || saved === null}
            onClick={() => fileInput.current?.click()}
          />
        </SettingsGroup>
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

        {folderId ? <ShareProjectButton folderId={folderId} /> : null}
        {error ? (
          <p className="mobile-memory-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={removing !== null}
        title={t("Remove this file?")}
        description={t("Chats in this project will no longer find it.")}
        confirmLabel={t("Remove")}
        destructive
        onConfirm={() => {
          if (removing) void removeFile(removing);
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
