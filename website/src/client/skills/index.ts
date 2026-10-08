/**
 * The web client's skill packs (ADR-0092): the synchronised `skill_packs`,
 * offered to every general turn the way agent-lite offers them.
 */
import { t } from "../../lib/i18n";
import type { TurnAddition, WebFeature } from "../feature";
import { CONNECTORS } from "../connectors/words";
import { LOAD_SKILL, listPacks, load, plan } from "./packs";
import { SkillsPanel } from "./SkillsPanel";

/** A turn's addition, plus the tools a picked skill narrows the turn to. */
export type SkillAddition = TurnAddition & {
  /** When not empty, only these tools may be offered this turn: the host
   * keeps the intersection, so a pack never widens a turn. */
  narrow: string[];
};

export const skillsFeature: WebFeature = {
  id: "skills",
  label: () => t("Skills", "Compétences"),
  Panel: SkillsPanel,
  turn(host, turn): SkillAddition | null {
    if (turn.temporary) return null;
    let packs: ReturnType<typeof listPacks>;
    try {
      packs = listPacks(host.sync);
    } catch {
      return null;
    }
    const skill = plan(packs, turn.question);
    if (!skill.prompt) return null;
    return {
      tools: skill.offerLoader ? [LOAD_SKILL] : [],
      prompt: skill.prompt,
      narrow: skill.narrow,
      async run(name, args) {
        if (name !== LOAD_SKILL.function.name) return undefined;
        try {
          return load(listPacks(host.sync), args);
        } catch {
          return CONNECTORS.skills.unreadable;
        }
      },
    };
  },
};
