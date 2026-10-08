import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { AGENT_LITE } from "../codec";
import type { Personalization } from "../agent";
import type { Memory } from "../library";

const PERSONALITIES: [string, () => string][] = [
  ["default", () => t("Default", "Par défaut")],
  ["professional", () => t("Professional", "Professionnelle")],
  ["friendly", () => t("Friendly", "Chaleureuse")],
  ["candid", () => t("Candid", "Franche")],
  ["efficient", () => t("Efficient", "Efficace")],
  ["nerdy", () => t("Curious", "Curieuse")],
];

/**
 * Personalization and memory for the browser. A native <dialog>, opened
 * modal, so focus, Escape and the backdrop are the browser's own.
 */
export function SettingsDialog({
  open,
  personalization,
  memory,
  memories,
  onSave,
  onClose,
}: {
  open: boolean;
  personalization: Personalization;
  memory: boolean;
  memories: Memory[];
  onSave: (personalization: Personalization, memory: boolean) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(personalization);
  const [memoryOn, setMemoryOn] = useState(memory);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setDraft(personalization);
      setMemoryOn(memory);
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    if (!open && element.open) {
      if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
    }
  }, [open, personalization, memory]);
  const max = AGENT_LITE.personalization.maxFieldChars;
  return (
    <dialog
      ref={dialog}
      className="wc-dialog"
      aria-labelledby="wc-settings-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <form
        className="form"
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft, memoryOn);
        }}
      >
        <h2 id="wc-settings-title">{t("Personalization", "Personnalisation")}</h2>
        <p className="quiet">
          {t(
            "These settings stay in this browser, sealed with your vault. The app keeps its own on each device, so nothing here changes your other devices.",
            "Ces réglages restent dans ce navigateur, scellés avec votre coffre. L’app garde les siens sur chaque appareil : rien ici ne change vos autres appareils.",
          )}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          {t(
            "Use personalization in new replies",
            "Utiliser la personnalisation dans les réponses",
          )}
        </label>
        <label>
          <span>
            {t("What should Sub Rosa know about you?", "Que doit savoir Sub Rosa de vous ?")}
          </span>
          <textarea
            rows={3}
            maxLength={max}
            value={draft.aboutYou}
            onChange={(event) => setDraft({ ...draft, aboutYou: event.target.value })}
          />
        </label>
        <label>
          <span>{t("How should Sub Rosa respond?", "Comment Sub Rosa doit-il répondre ?")}</span>
          <textarea
            rows={3}
            maxLength={max}
            value={draft.responseStyle}
            onChange={(event) => setDraft({ ...draft, responseStyle: event.target.value })}
          />
        </label>
        <label>
          <span>{t("Personality", "Personnalité")}</span>
          <select
            value={draft.personality}
            onChange={(event) => setDraft({ ...draft, personality: event.target.value })}
          >
            {PERSONALITIES.map(([id, label]) => (
              <option key={id} value={id}>
                {label()}
              </option>
            ))}
          </select>
        </label>
        <h2>{t("Memory", "Mémoire")}</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={memoryOn}
            onChange={(event) => setMemoryOn(event.target.checked)}
          />
          {t("Use and add to your memories here", "Utiliser et enrichir vos souvenirs ici")}
        </label>
        <p className="quiet">
          {memories.length === 0
            ? t(
                "No memory has synchronised to this account yet.",
                "Aucun souvenir n’a encore été synchronisé sur ce compte.",
              )
            : memories.length === 1
              ? t(
                  "1 memory synchronised from your devices. Manage them in the app.",
                  "1 souvenir synchronisé depuis vos appareils. Gérez-les dans l’app.",
                )
              : t(
                  `${memories.length} memories synchronised from your devices. Manage them in the app.`,
                  `${memories.length} souvenirs synchronisés depuis vos appareils. Gérez-les dans l’app.`,
                )}
        </p>
        <div className="wc-row">
          <button className="button primary" type="submit">
            {t("Save", "Enregistrer")}
          </button>
          <button className="button" type="button" onClick={onClose}>
            {t("Cancel", "Annuler")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
