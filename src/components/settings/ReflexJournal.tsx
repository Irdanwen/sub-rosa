import { useCallback, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { type AutonomousChangeDto, reflexJournal, reflexUndo } from "../../lib/reflex";
import { SettingsGroup, SettingsRow } from "../mobile/SettingsList";

/** What a change did, in one sentence a person reads. */
export function changeSentence(change: AutonomousChangeDto): string {
  switch (change.kind) {
    case "memory_update":
      return t("Replaced “{before}” with “{after}”", {
        before: change.before.text,
        after: change.after.text,
      });
    case "memory_same":
      return t("Did not store “{fact}”, already known as “{known}”", {
        fact: change.before.text,
        known: change.after.text,
      });
    case "memory_forget":
      return t("Paused “{fact}”, which a newer fact made untrue", { fact: change.before.text });
    default:
      return t("Changed a memory");
  }
}

/**
 * The journal of what Sub Rosa changed in memory on its own (ADR-0065), and
 * the undo for each. Loaded once; an undo updates its row in place.
 */
export function useReflexJournal() {
  const [changes, setChanges] = useState<AutonomousChangeDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => reflexJournal())
      .then((next) => {
        // A bridge without the command answers nothing: show nothing.
        if (live && Array.isArray(next)) setChanges(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const undo = useCallback(async (change: AutonomousChangeDto) => {
    setError(null);
    try {
      const done = await reflexUndo(change.id);
      setChanges((current) => current.map((item) => (item.id === done.id ? done : item)));
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  return { changes, error, undo };
}

/** Settings › Memory on the desktop. Absent until there is something in it. */
export function ReflexJournalCard() {
  const { changes, error, undo } = useReflexJournal();
  if (changes.length === 0) return null;
  return (
    <div className="settings-card">
      <div className="settings-row-text">
        <h3 className="settings-row-title">{t("Changed by Sub Rosa")}</h3>
        <p className="settings-row-description">
          {t(
            "When a new fact replaces or repeats one it already knows, Sub Rosa updates your memory on its own. Each change can be undone.",
          )}
        </p>
      </div>
      <div className="settings-rows">
        {changes.map((change) => (
          <div key={change.id} className="settings-row settings-row-compact">
            <div className="settings-row-info">
              <p className="settings-row-description">{changeSentence(change)}</p>
            </div>
            <div className="settings-row-control">
              {change.undoneAt ? (
                <span className="settings-row-description">{t("Undone")}</span>
              ) : (
                <button type="button" className="primary-action" onClick={() => void undo(change)}>
                  {t("Undo")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {error ? <p className="settings-row-error">{error}</p> : null}
    </div>
  );
}

/** The same journal as a group of the phone's Memory screen. */
export function ReflexJournalGroup() {
  const { changes, error, undo } = useReflexJournal();
  if (changes.length === 0) return null;
  return (
    <SettingsGroup
      title={t("Changed by Sub Rosa")}
      footer={
        error ??
        t(
          "When a new fact replaces or repeats one it already knows, Sub Rosa updates your memory on its own. Each change can be undone.",
        )
      }
    >
      {changes.map((change) => (
        <SettingsRow key={change.id} label={changeSentence(change)}>
          {change.undoneAt ? (
            <span className="mobile-memory-meta">{t("Undone")}</span>
          ) : (
            <button type="button" className="mobile-memory-undo" onClick={() => void undo(change)}>
              {t("Undo")}
            </button>
          )}
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
