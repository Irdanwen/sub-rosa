import { describe, expect, it } from "vitest";
import {
  humanizeToolName,
  settledToolLabel,
  toolActivityLabel,
  toolActivitySentence,
} from "../lib/agent-tool-labels";

describe("toolActivityLabel", () => {
  it("replaces generic terminal labels with the command activity", () => {
    expect(toolActivityLabel("terminal")).toBe("Running command");
    expect(
      toolActivityLabel("terminal", {
        command: "curl https://example.com/docs",
      }),
    ).toBe("Browsing");
    expect(toolActivityLabel("shell", { command: "rg -n Terminal src" })).toBe("Searching files");
  });

  it("labels common web and file tools by intent", () => {
    expect(toolActivityLabel("web.run", { search_query: [{ q: "June status" }] })).toBe(
      "Searching web",
    );
    expect(toolActivityLabel("fetch_url", { url: "https://example.com" })).toBe("Browsing");
    expect(toolActivityLabel("read_file", { path: "src/App.tsx" })).toBe("Reading files");
    expect(toolActivityLabel("write_file", { path: "src/App.tsx" })).toBe("Editing files");
  });

  it("keeps an understandable fallback for unknown tools", () => {
    expect(humanizeToolName("custom_deploy_tool")).toBe("Custom deploy tool");
    expect(toolActivityLabel("custom_deploy_tool")).toBe("Custom deploy tool");
  });

  it("composes activity labels as standalone status sentences", () => {
    expect(toolActivitySentence("read_file")).toBe("Reading files.");
    expect(toolActivitySentence("gh")).toBe("Using GitHub.");
    expect(toolActivitySentence(undefined)).toBe("Using a tool.");
  });
});

describe("an activity that is over", () => {
  it("stops claiming to be happening now", () => {
    // The wall this exists for: twenty finished rows all reading "Running
    // command", none of them distinguishable from the one still running.
    expect(settledToolLabel("Running command")).toBe("Ran command");
    expect(settledToolLabel("Reading files")).toBe("Read files");
    expect(settledToolLabel("Searching web")).toBe("Searched the web");
    expect(settledToolLabel("Building")).toBe("Built");
  });

  it("covers every label this module mints", () => {
    // A label added to the set without a past tense would keep saying "now"
    // forever, which is the bug being fixed. Listed here rather than read off
    // the internal table, so adding one to the source does not silently add
    // it to its own test.
    for (const label of [
      "Running command",
      "Browsing",
      "Searching web",
      "Searching",
      "Searching files",
      "Searching images",
      "Editing files",
      "Reading files",
      "Working with images",
      "Using GitHub",
      "Inspecting repository",
      "Running tests",
      "Building",
      "Checking code",
    ]) {
      expect(settledToolLabel(label)).not.toBe(label);
    }
  });

  it("rewrites the commands minted from a command name", () => {
    expect(settledToolLabel("Running npm test")).toBe("Ran npm test");
  });

  it("leaves a humanized tool name alone", () => {
    // There is no safe way to conjugate an arbitrary wire name, and a wrong
    // guess reads worse than the present tense.
    expect(settledToolLabel("Fetch data")).toBe("Fetch data");
    expect(settledToolLabel("Tool")).toBe("Tool");
  });
});
