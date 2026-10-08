// Skill packs on the phone (ADR-0092): `/` at the start of a draft offers the
// installed skills, and picking one writes its name into the draft.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/haptics", () => ({ hapticSelection: () => undefined }));

import { SkillSlashMenu } from "../components/mobile/SkillSlashMenu";
import { type SkillPack, matchingSkills, slashQuery } from "../lib/skill-packs";

function pack(name: string, enabled = true): SkillPack {
  return {
    id: name,
    name,
    description: `The ${name} skill`,
    body: "",
    tools: [],
    enabled,
    updatedAt: "",
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue([pack("weekly-review"), pack("draft"), pack("hidden", false)]);
});

describe("the slash query", () => {
  it("is only the name being typed at the start", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/wee")).toBe("wee");
    expect(slashQuery("/weekly-review ")).toBeNull();
    expect(slashQuery("hi /draft")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });

  it("matches enabled skills by prefix", () => {
    const packs = [pack("weekly-review"), pack("draft"), pack("hidden", false)];
    expect(matchingSkills(packs, "").map((item) => item.name)).toEqual(["weekly-review", "draft"]);
    expect(matchingSkills(packs, "dr").map((item) => item.name)).toEqual(["draft"]);
    expect(matchingSkills(packs, "hid")).toEqual([]);
  });
});

describe("the slash menu", () => {
  it("offers the skills and writes the picked one into the draft", async () => {
    const onPick = vi.fn();
    render(<SkillSlashMenu draft="/we" onPick={onPick} />);
    fireEvent.click(await screen.findByRole("button", { name: /weekly-review/ }));
    expect(onPick).toHaveBeenCalledWith("/weekly-review ");
    expect(screen.queryByText("/draft")).toBeNull();
  });

  it("stays out of the way of an ordinary draft", async () => {
    const { container } = render(<SkillSlashMenu draft="hello" onPick={vi.fn()} />);
    await Promise.resolve();
    expect(container.textContent).toBe("");
  });
});
