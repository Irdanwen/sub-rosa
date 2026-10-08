import { useState } from "react";
import { t } from "../../lib/i18n";
import type { FeatureHost } from "../feature";
import "../connectors/ui/connectors.css";
import { deletePack, listPacks, parseSkillMd, SkillError, savePack, setPackEnabled } from "./packs";

function errorText(error: unknown) {
  if (error instanceof SkillError && error.code === "skill_pack_name")
    return t(
      "A skill name uses lowercase letters, digits and dashes, up to 64 characters.",
      "Un nom de compétence utilise des minuscules, des chiffres et des tirets, jusqu’à 64 caractères.",
    );
  if (error instanceof SkillError && error.code === "skill_pack_invalid")
    return t(
      "This file is not a skill. It needs a name and a description at the top, between two lines of three dashes.",
      "Ce fichier n’est pas une compétence. Il lui faut un nom et une description en haut, entre deux lignes de trois tirets.",
    );
  return t(
    "The skill could not be saved. Try again.",
    "La compétence n’a pas pu être enregistrée. Réessayez.",
  );
}

const TEMPLATE = "---\nname: \ndescription: \n---\n";

/** Skills: the account's skill packs, added and edited from the browser too. */
export function SkillsPanel({ host }: { host: FeatureHost }) {
  const packs = listPacks(host.sync);
  const [draft, setDraft] = useState(TEMPLATE);
  const [error, setError] = useState("");
  const act = async (work: () => Promise<unknown>) => {
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      host.refresh();
    }
  };
  return (
    <div className="cn-section">
      <h1>{t("Skills", "Compétences")}</h1>
      <p className="quiet">
        {t(
          "A skill is a set of instructions the assistant reads when it fits the request. Type /name at the start of a message to use one now. Skills travel with your account.",
          "Une compétence est un ensemble d’instructions que l’assistant lit quand elle correspond à la demande. Tapez /nom au début d’un message pour en utiliser une tout de suite. Les compétences suivent votre compte.",
        )}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {packs.length === 0 && (
        <p className="quiet">{t("No skill yet.", "Aucune compétence pour l’instant.")}</p>
      )}
      <ul className="cn-list">
        {packs.map((pack) => (
          <li key={pack.id} className="cn-item">
            <div className="wc-row">
              <strong>/{pack.name}</strong>
              <span className="quiet">{pack.description}</span>
            </div>
            <div className="wc-row">
              <label className="wc-row">
                <input
                  type="checkbox"
                  checked={pack.enabled}
                  onChange={(event) =>
                    void act(() => setPackEnabled(host.sync, pack.id, event.target.checked))
                  }
                />
                {t("On", "Activée")}
              </label>
              <button
                className="button"
                type="button"
                onClick={() =>
                  setDraft(
                    `---\nname: ${pack.name}\ndescription: ${pack.description}\n${
                      pack.tools.length ? `tools: [${pack.tools.join(", ")}]\n` : ""
                    }---\n${pack.body}\n`,
                  )
                }
              >
                {t("Edit", "Modifier")}
              </button>
              <button
                className="button"
                type="button"
                onClick={() => void act(() => deletePack(host.sync, pack.id))}
              >
                {t("Remove", "Retirer")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form
        className="cn-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await savePack(host.sync, parseSkillMd(draft));
            setDraft(TEMPLATE);
          });
        }}
      >
        <label htmlFor="skill-draft">
          {t(
            "A skill in the SKILL.md format: a name and a description between two lines of three dashes, then its instructions",
            "Une compétence au format SKILL.md : un nom et une description entre deux lignes de trois tirets, puis ses instructions",
          )}
        </label>
        <textarea
          id="skill-draft"
          rows={10}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="wc-row">
          <button className="button primary" type="submit">
            {t("Save the skill", "Enregistrer la compétence")}
          </button>
        </div>
      </form>
    </div>
  );
}
