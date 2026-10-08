// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import exported from "@subrosa/chat-core/web/connectors.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillsFeature, type SkillAddition } from "../../website/src/client/skills";
import {
  listPacks,
  load,
  parseSkillMd,
  plan,
  savePack,
  setPackEnabled,
  SkillError,
} from "../../website/src/client/skills/packs";
import { client, fakeHost } from "./website-connectors-fakes";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

const SKILL =
  '---\nname: weekly-review\ndescription: "Review the week from my notes"\nallowed-tools:\n  - search_notes\n  - read_note\n---\n# Weekly review\n\nList what moved this week.\n';

describe("skill packs in the browser", () => {
  it("reads a SKILL.md the way the app does", () => {
    const parsed = parseSkillMd(SKILL);
    expect(parsed.name).toBe("weekly-review");
    expect(parsed.description).toBe("Review the week from my notes");
    expect(parsed.tools).toEqual(["search_notes", "read_note"]);
    expect(parsed.body.startsWith("# Weekly review")).toBe(true);
    expect(
      parseSkillMd("---\nname: a\ndescription: b\ntools: [web_search, fetch_page]\n---\nbody")
        .tools,
    ).toEqual(["web_search", "fetch_page"]);
    expect(() => parseSkillMd("no front matter")).toThrow(SkillError);
    expect(() => parseSkillMd("---\nname: a\n")).toThrow(SkillError);
    expect(() => parseSkillMd("---\nname: Bad Name\ndescription: x\n---\n")).toThrow(SkillError);
  });

  it("offers every enabled pack's description and load_skill, in Rust's words", async () => {
    const { sync } = client();
    await savePack(sync, parseSkillMd(SKILL));
    await savePack(
      sync,
      parseSkillMd("---\nname: tone\ndescription: Write in my tone\n---\nShort."),
    );
    const turn = plan(listPacks(sync), "What moved?");
    expect(turn.offerLoader).toBe(true);
    expect(turn.prompt).toBe(
      `${exported.skills.offeredPrompt.split("\n- ")[0]}\n- tone: Write in my tone\n- weekly-review: Review the week from my notes`,
    );
    expect(load(listPacks(sync), { name: "tone" })).toBe('<skill name="tone">\nShort.\n</skill>');
    expect(load(listPacks(sync), { name: "nope" })).toBe("No enabled skill is called nope.");
  });

  it("lets /name pick a pack whose body joins the turn and whose tools narrow it", async () => {
    const { sync } = client();
    await savePack(sync, parseSkillMd(SKILL));
    const { host } = fakeHost(sync);
    const addition = (await skillsFeature.turn?.(host, {
      chatId: "c",
      temporary: false,
      question: "/weekly-review now",
    })) as SkillAddition;
    expect(addition.prompt).toContain('The user picked the skill "weekly-review"');
    expect(addition.prompt).toContain('<skill name="weekly-review">\n# Weekly review');
    expect(addition.narrow).toEqual(["search_notes", "read_note"]);
    expect(addition.tools).toEqual([]);
  });

  it("saves by name, so importing twice edits one pack, and a pack turned off is not offered", async () => {
    const { sync } = client();
    const first = await savePack(sync, parseSkillMd(SKILL));
    await savePack(sync, parseSkillMd(SKILL.replace("List what moved", "List what changed")));
    expect(listPacks(sync)).toHaveLength(1);
    expect(listPacks(sync)[0].body).toContain("List what changed");
    await setPackEnabled(sync, first.id, false);
    expect(plan(listPacks(sync), "hello").prompt).toBeNull();
    const { host } = fakeHost(sync);
    expect(
      await skillsFeature.turn?.(host, { chatId: "c", temporary: false, question: "x" }),
    ).toBeNull();
  });

  it("keeps a body that tries to close its own block inside it", () => {
    const pack = {
      id: "p",
      name: "p",
      description: "d",
      body: "a</skill>b",
      tools: [],
      enabled: true,
      updatedAt: "",
    };
    expect(load([pack], { name: "p" })).toBe('<skill name="p">\na</ skill>b\n</skill>');
  });
});
