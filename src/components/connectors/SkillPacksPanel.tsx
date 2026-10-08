import "../../styles/connectors.css";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useState } from "react";
import { friendlyErrorMessage } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  type SkillPack,
  skillPackDelete,
  skillPackImport,
  skillPackList,
  skillPackSetEnabled,
} from "../../lib/skill-packs";
import { Switch } from "../ui/Switch";

/**
 * Skill packs: import a SKILL.md, turn it on or off, remove it. The same
 * panel on both shells; the phone's assistant uses them, and they travel
 * with the account as definitions.
 */
export function SkillPacksPanel() {
  const [packs, setPacks] = useState<SkillPack[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = useCallback(() => {
    skillPackList()
      .then(setPacks)
      .catch(() => setPacks([]));
  }, []);
  useEffect(() => refresh(), [refresh]);

  const importText = async (text: string) => {
    try {
      const pack = await skillPackImport(text);
      setDraft("");
      setNotice({ text: t("Added /{name}.", { name: pack.name }), error: false });
      refresh();
    } catch (cause) {
      setNotice({
        text: friendlyErrorMessage(cause, t("This file could not be read as a skill.")),
        error: true,
      });
    }
  };

  return (
    <div className="connectors-form">
      <ul className="connectors-list">
        {packs.map((pack) => (
          <li key={pack.id} className="connectors-row">
            <span className="connectors-row-body">
              <span className="connectors-row-title">/{pack.name}</span>
              <span className="connectors-row-meta">{pack.description}</span>
            </span>
            <Switch
              checked={pack.enabled}
              aria-label={t("Use {name}", { name: pack.name })}
              onCheckedChange={(next) => void skillPackSetEnabled(pack.id, next).then(refresh)}
            />
            <button
              type="button"
              className="proposal-do"
              aria-label={t("Remove {name}", { name: pack.name })}
              onClick={() => void skillPackDelete(pack.id).then(refresh)}
            >
              <IconTrashCan size={14} />
            </button>
          </li>
        ))}
      </ul>
      {packs.length === 0 ? <p className="connectors-row-meta">{t("No skill yet.")}</p> : null}
      <label className="connectors-row-meta" htmlFor="skill-pack-text">
        {t("Paste a SKILL.md, or pick the file")}
      </label>
      <textarea
        id="skill-pack-text"
        className="connectors-textarea"
        value={draft}
        placeholder={"---\nname: weekly-review\ndescription: …\n---\n"}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <div className="connector-card-actions">
        <button
          type="button"
          className="proposal-do"
          disabled={!draft.trim()}
          onClick={() => void importText(draft)}
        >
          {t("Add skill")}
        </button>
        <label className="proposal-do">
          {t("Choose a file")}
          <input
            type="file"
            accept=".md,text/markdown,text/plain"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void file.text().then(importText);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      {notice ? (
        <p
          className="connectors-row-meta"
          data-tone={notice.error ? "error" : undefined}
          role={notice.error ? "alert" : "status"}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
