/**
 * Skill packs (ADR-0092): a SKILL.md made portable, so a phone has skills
 * too. Imported here, synchronised as a definition, read by the phone's
 * assistant: offered by description, loaded when picked, and picked directly
 * with `/name` at the start of a message.
 */

import { invoke } from "@tauri-apps/api/core";

export type SkillPack = {
  id: string;
  name: string;
  description: string;
  body: string;
  tools: string[];
  enabled: boolean;
  updatedAt: string;
};

export function skillPackList() {
  return invoke<SkillPack[]>("skill_pack_list");
}

export function skillPackImport(text: string) {
  return invoke<SkillPack>("skill_pack_import", { request: { text } });
}

export function skillPackSetEnabled(id: string, enabled: boolean) {
  return invoke<void>("skill_pack_set_enabled", { id, enabled });
}

export function skillPackDelete(id: string) {
  return invoke<void>("skill_pack_delete", { id });
}

/** The `/name` being typed at the very start of a draft, before any space;
 * null once the draft is anything else. */
export function slashQuery(draft: string): string | null {
  const match = /^\/([a-z0-9-]*)$/.exec(draft);
  return match ? match[1] : null;
}

/** The enabled packs whose name starts with what was typed, at most six. */
export function matchingSkills(packs: SkillPack[], query: string): SkillPack[] {
  return packs.filter((pack) => pack.enabled && pack.name.startsWith(query)).slice(0, 6);
}
