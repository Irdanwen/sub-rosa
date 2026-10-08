import { useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  type Space,
  spacesDeleteObject,
  spacesSaveNote,
  spacesSaveProject,
} from "../../lib/spaces";

type Draft = { id: string | null; title: string; body: string };

/** The project everyone shares: its name and instructions, notes, and files. */
export function SpaceContent({
  space,
  onChanged,
}: {
  space: Space;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(space.summary.name);
  const [instructions, setInstructions] = useState(space.instructions);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writable = space.summary.state === "active";

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="spaces-content">
      {error ? (
        <p role="alert" className="spaces-hint">
          {error}
        </p>
      ) : null}
      <section className="spaces-section">
        <h3 className="spaces-heading">{t("Project")}</h3>
        <label className="dialog-field">
          <span className="dialog-field-label">{t("Name")}</span>
          <input
            className="dialog-input"
            value={name}
            maxLength={200}
            disabled={!writable}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="dialog-field">
          <span className="dialog-field-label">{t("Instructions")}</span>
          <textarea
            className="dialog-textarea"
            rows={4}
            value={instructions}
            maxLength={8000}
            disabled={!writable}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <span className="dialog-field-hint">
            {t("The assistant follows them in this project's chats, whoever asks.")}
          </span>
        </label>
        {writable ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={
              busy ||
              !name.trim() ||
              (name === space.summary.name && instructions === space.instructions)
            }
            onClick={() => void run(() => spacesSaveProject(space.summary.id, name, instructions))}
          >
            {t("Save")}
          </button>
        ) : null}
      </section>
      <section className="spaces-section">
        <h3 className="spaces-heading">{t("Notes")}</h3>
        {draft ? (
          <div className="spaces-editor">
            <input
              className="dialog-input"
              aria-label={t("Title")}
              placeholder={t("Title")}
              value={draft.title}
              maxLength={300}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
            <textarea
              className="dialog-textarea"
              rows={8}
              aria-label={t("Note")}
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
            <div className="spaces-row">
              <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !draft.title.trim()}
                onClick={() =>
                  void run(async () => {
                    await spacesSaveNote(space.summary.id, draft.id, draft.title, draft.body);
                    setDraft(null);
                  })
                }
              >
                {t("Save note")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <ul className="spaces-list">
              {space.notes.map((note) => (
                <li key={note.id} className="spaces-list-item">
                  <span className="spaces-list-main">
                    <span className="spaces-list-title">{note.title || t("Untitled note")}</span>
                    <span className="settings-row-description">
                      {note.pending ? t("Sending…") : (note.authorName ?? "")}
                    </span>
                  </span>
                  {writable ? (
                    <span className="spaces-row">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() =>
                          setDraft({ id: note.id, title: note.title, body: note.body })
                        }
                      >
                        {t("Edit")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(() => spacesDeleteObject(space.summary.id, note.id))
                        }
                      >
                        {t("Delete")}
                      </button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {writable ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDraft({ id: null, title: "", body: "" })}
              >
                {t("New note")}
              </button>
            ) : null}
          </>
        )}
      </section>
      <section className="spaces-section">
        <h3 className="spaces-heading">{t("Files")}</h3>
        {space.files.length === 0 ? (
          <p className="spaces-hint">
            {t("The text of the project's files, as it was when the project was shared.")}
          </p>
        ) : (
          <ul className="spaces-list">
            {space.files.map((file) => (
              <li key={file.id} className="spaces-list-item">
                <span className="spaces-list-main">
                  <span className="spaces-list-title">{file.title}</span>
                  <span className="settings-row-description">
                    {t("{count} characters", { count: file.body.length.toLocaleString() })}
                  </span>
                </span>
                {writable ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => void run(() => spacesDeleteObject(space.summary.id, file.id))}
                  >
                    {t("Remove")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
