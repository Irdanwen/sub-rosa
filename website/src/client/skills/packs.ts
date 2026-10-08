/**
 * Skill packs on the web (ADR-0092): a `SKILL.md` made portable, synchronised
 * as a `skill_packs` row, read the way agent-lite reads it. Every turn is
 * offered the enabled packs' names and descriptions and `load_skill`; a
 * message that starts with `/name` picks one, whose body joins that turn and
 * whose tool list narrows it. A pack only ever narrows what a turn may use.
 *
 * The parsing and the plan are ports of `skill_packs/mod.rs` and
 * `skill_packs/agent.rs`; the words are Rust's (`connectors.json`).
 */
import type { Row, ToolDefinition } from "../codec";
import { timestamp } from "../codec";
import { CONNECTORS, fill } from "../connectors/words";
import type { SyncClient } from "../sync";

export interface SkillPack {
  id: string;
  name: string;
  description: string;
  body: string;
  tools: string[];
  enabled: boolean;
  updatedAt: string;
}

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  tools: string[];
}

export class SkillError extends Error {
  constructor(public code: "skill_pack_invalid" | "skill_pack_name" | "skill_pack_missing") {
    super(code);
  }
}

const MAX_DESCRIPTION_CHARS = 400;
const chars = (text: string, max: number) => Array.from(text).slice(0, max).join("");

export function validName(name: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(name) && !name.startsWith("-");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  for (const quote of ['"', "'"])
    if (trimmed.length >= 2 && trimmed.startsWith(quote) && trimmed.endsWith(quote))
      return trimmed.slice(1, -1);
  return trimmed;
}

/** `parse_skill_md`: the front matter's name, description and tools, and the
 * body after it. Anything but the simple shape is refused. */
export function parseSkillMd(raw: string): ParsedSkill {
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new SkillError("skill_pack_invalid");
  let name: string | null = null;
  let description: string | null = null;
  let tools: string[] = [];
  let inTools = false;
  let closed = false;
  let consumed = 1;
  for (const line of lines.slice(1)) {
    consumed += 1;
    if (line.trim() === "---") {
      closed = true;
      break;
    }
    if (inTools) {
      const item = /^\s*- (.*)$/.exec(line);
      if (item) {
        tools.push(unquote(item[1]));
        continue;
      }
      inTools = false;
    }
    const at = line.indexOf(":");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1);
    if (key === "name") name = unquote(value);
    else if (key === "description") description = unquote(value);
    else if (key === "allowed-tools" || key === "tools") {
      const list = value.trim();
      if (!list) inTools = true;
      else
        tools.push(
          ...list.replace(/^\[+/, "").replace(/\]+$/, "").split(",").map(unquote).filter(Boolean),
        );
    }
  }
  if (!closed || !name) throw new SkillError("skill_pack_invalid");
  if (!validName(name)) throw new SkillError("skill_pack_name");
  if (!description?.trim()) throw new SkillError("skill_pack_invalid");
  const body = chars(lines.slice(consumed).join("\n").trim(), CONNECTORS.skills.maxBodyChars);
  tools = tools.filter((tool) => tool && tool.length <= 128 && /^[A-Za-z0-9_-]+$/.test(tool));
  tools = tools.filter((tool, index) => index === 0 || tool !== tools[index - 1]).slice(0, 40);
  return { name, description: chars(description, MAX_DESCRIPTION_CHARS), body, tools };
}

function packOf(row: Record<string, unknown>): SkillPack {
  let tools: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.tools ?? "[]"));
    if (Array.isArray(parsed))
      tools = parsed.filter((tool): tool is string => typeof tool === "string");
  } catch {
    tools = [];
  }
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    body: String(row.body ?? ""),
    tools,
    enabled: Number(row.enabled) !== 0,
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function listPacks(sync: SyncClient): SkillPack[] {
  return sync
    .rows("skill_packs")
    .map((object) => packOf(object.row))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `skill_packs::save`: a new row, or the row that already has its name. */
export async function savePack(sync: SyncClient, parsed: ParsedSkill): Promise<SkillPack> {
  const existing = sync.rows("skill_packs").find((object) => object.row.name === parsed.name);
  const now = timestamp();
  const row: Row = existing
    ? {
        ...existing.row,
        description: parsed.description,
        body: parsed.body,
        tools: JSON.stringify(parsed.tools),
        updated_at: now,
      }
    : {
        id: crypto.randomUUID(),
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        tools: JSON.stringify(parsed.tools),
        enabled: 1,
        created_at: now,
        updated_at: now,
      };
  await sync.write("skill_packs", row);
  return packOf(row);
}

export async function setPackEnabled(sync: SyncClient, id: string, enabled: boolean) {
  const object = sync.objects.get(id);
  if (!object || object.deleted) throw new SkillError("skill_pack_missing");
  await sync.write("skill_packs", {
    ...object.row,
    enabled: enabled ? 1 : 0,
    updated_at: timestamp(),
  });
}

export async function deletePack(sync: SyncClient, id: string) {
  const object = sync.objects.get(id);
  if (object && !object.deleted) await sync.write("skill_packs", object.row, { deleted: true });
}

/** The pack a message picks with `/name` at its start. */
export function picked(packs: SkillPack[], message: string): SkillPack | null {
  const rest = message.trimStart();
  if (!rest.startsWith("/")) return null;
  const name = /^\/(\S*)/.exec(rest)?.[1] ?? "";
  return packs.find((pack) => pack.enabled && pack.name === name) ?? null;
}

export function bodyBlock(pack: Pick<SkillPack, "name" | "body">): string {
  const picked = CONNECTORS.skills.pickedPrompt;
  const start = picked.indexOf("<skill");
  return fill(picked.slice(start), {
    name: pack.name,
    body: pack.body.replaceAll("</skill>", "</ skill>"),
  });
}

export interface SkillTurn {
  prompt: string | null;
  /** The tools a picked skill narrows the turn to, when it names any. */
  narrow: string[];
  offerLoader: boolean;
}

/** `agent::plan`. */
export function plan(packs: SkillPack[], message: string): SkillTurn {
  const pack = picked(packs, message);
  if (pack)
    return {
      prompt: fill(CONNECTORS.skills.pickedPrompt, {
        name: pack.name,
        body: pack.body.replaceAll("</skill>", "</ skill>"),
      }),
      narrow: pack.tools,
      offerLoader: false,
    };
  const offered = packs.filter((item) => item.enabled).slice(0, CONNECTORS.skills.maxOffered);
  if (!offered.length) return { prompt: null, narrow: [], offerLoader: false };
  const template = CONNECTORS.skills.offeredPrompt;
  const cut = template.indexOf("\n- {name}");
  const header = template.slice(0, cut);
  const line = template.slice(cut + 1);
  return {
    prompt: `${header}\n${offered
      .map((item) => fill(line, { name: item.name, description: item.description }))
      .join("\n")}`,
    narrow: [],
    offerLoader: true,
  };
}

/** `agent::load`: the body of an enabled pack, or the sentence saying it is
 * not there. */
export function load(packs: SkillPack[], args: Record<string, unknown>): string {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const pack = packs.find((item) => item.enabled && item.name === name);
  return pack ? bodyBlock(pack) : fill(CONNECTORS.skills.missing, { name });
}

export const LOAD_SKILL: ToolDefinition = CONNECTORS.skills.loadSkill;
