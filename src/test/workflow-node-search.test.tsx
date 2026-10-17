/**
 * Finding a step by typing: every type by its name and a few words, grouped
 * by what it is for; while a connection is dragged, only the steps that can
 * take it (or feed it), with an asset already set to the kind wanted.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NodeSearch } from "../components/studio/workflow/NodeSearch";
import { fuzzyScore, searchNodeTypes } from "../lib/studio/workflow/node-search";

describe("searching steps", () => {
  it("scores letters in order, with word starts and runs counting more", () => {
    expect(fuzzyScore("vid", "Video")).toBeGreaterThan(fuzzyScore("vdo", "Video"));
    expect(fuzzyScore("xyz", "Video")).toBe(0);
    expect(fuzzyScore("", "anything")).toBe(1);
  });

  it("finds a step by its name or by a word it is known by", () => {
    expect(searchNodeTypes("vid")[0]?.type).toBe("video");
    expect(searchNodeTypes("voice").map((hit) => hit.type)).toContain("tts");
    expect(searchNodeTypes("montage").map((hit) => hit.type)).toContain("assemble");
  });

  it("lists everything grouped by purpose when nothing is typed", () => {
    const categories = searchNodeTypes("").map((hit) => hit.category);
    expect(categories[0]).toBe("inputs");
    expect(categories.at(-1)).toBe("flow");
    expect(categories.indexOf("generate")).toBeLessThan(categories.indexOf("montage"));
  });

  it("offers only steps that take a dragged video, and only feeders of an image input", () => {
    const takesVideo = searchNodeTypes("", { from: "output", kind: "video" }).map(
      (hit) => hit.type,
    );
    expect(takesVideo).toEqual(expect.arrayContaining(["lastFrame", "assemble", "gate", "output"]));
    expect(takesVideo).not.toContain("tts");
    const feedsImage = searchNodeTypes("", { from: "input", kind: "image" });
    expect(feedsImage.map((hit) => hit.type)).toEqual(
      expect.arrayContaining(["image", "lastFrame"]),
    );
    expect(feedsImage.map((hit) => hit.type)).not.toContain("chat");
    expect(feedsImage.find((hit) => hit.type === "asset")?.params).toEqual({ assetKind: "image" });
  });
});

describe("the search surface", () => {
  it("narrows as you type and adds the highlighted step with Enter", async () => {
    const onPick = vi.fn();
    render(<NodeSearch at={{ x: 10, y: 10 }} onPick={onPick} onClose={() => {}} />);
    const field = screen.getByRole("textbox", { name: "Search steps" });
    expect(field).toHaveFocus();
    await userEvent.type(field, "music");
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ type: "music" }));
  });

  it("moves through the list with the arrows, and says when nothing matches", async () => {
    const onPick = vi.fn();
    render(<NodeSearch at={{ x: 0, y: 0 }} onPick={onPick} onClose={() => {}} />);
    const field = screen.getByRole("textbox", { name: "Search steps" });
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onPick.mock.calls[0][0].type).toBe(searchNodeTypes("")[1].type);
    await userEvent.type(field, "zzzz");
    expect(screen.getByText("No step matches.")).toBeInTheDocument();
  });
});
