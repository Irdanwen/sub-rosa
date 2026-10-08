import "../../styles/connectors.css";
import { useEffect, useState } from "react";
import { hapticSelection } from "../../lib/haptics";
import { t } from "../../lib/i18n";
import { type SkillPack, matchingSkills, skillPackList, slashQuery } from "../../lib/skill-packs";

/**
 * The skills a `/` at the start of a draft offers (ADR-0092). Picking one
 * writes `/name ` into the draft; the phone's assistant reads the skill for
 * that message. Nothing shows when no skill is installed.
 */
export function SkillSlashMenu({
  draft,
  onPick,
}: {
  draft: string;
  onPick: (draft: string) => void;
}) {
  const [packs, setPacks] = useState<SkillPack[]>([]);
  useEffect(() => {
    let cancelled = false;
    skillPackList()
      .then((list) => {
        if (!cancelled) setPacks(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const query = slashQuery(draft);
  if (query === null) return null;
  const matches = matchingSkills(packs, query);
  if (matches.length === 0) return null;
  return (
    <ul className="composer-skill-menu" aria-label={t("Skills")}>
      {matches.map((pack) => (
        <li key={pack.id}>
          <button
            type="button"
            className="composer-skill-option"
            onClick={() => {
              hapticSelection();
              onPick(`/${pack.name} `);
            }}
          >
            <span>/{pack.name}</span>
            <span>{pack.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
