import { afterEach, describe, expect, it } from "vitest";
import {
  toolActivitySentenceText,
  toolActivityText,
  toolLabelText,
  toolRowLabel,
} from "../lib/agent-tool-label-text";
import { settledToolLabel, toolActivityKind, toolActivityLabel } from "../lib/agent-tool-labels";
import { applyLocale } from "../lib/i18n";

// Every label `agent-tool-labels` can mint, running and settled.
const RUNNING = [
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
];

describe("tool activity labels in the reader's language", () => {
  afterEach(() => applyLocale("en"));

  it("shows every minted label, running and settled, translated in French", () => {
    applyLocale("fr");
    for (const label of RUNNING) {
      expect(toolRowLabel(label, true)).not.toBe(label);
      expect(toolRowLabel(label, false)).not.toBe(settledToolLabel(label));
    }
    expect(toolRowLabel("Browsing", true)).toBe("Navigation sur le web");
    expect(toolRowLabel("Browsing", false)).toBe("Page consultée");
    expect(toolRowLabel("Running command", false)).toBe("Commande exécutée");
  });

  it("keeps the English keys for classification", () => {
    applyLocale("fr");
    // The label on the transcript is still the key, whatever the language.
    expect(toolActivityLabel("fetch_url", { url: "https://example.com" })).toBe("Browsing");
    expect(toolActivityKind("Browsing")).toBe("browse");
    expect(settledToolLabel("Browsing")).toBe("Browsed");
  });

  it("leaves a tool name humanized from the wire as it is", () => {
    applyLocale("fr");
    expect(toolLabelText("Custom deploy tool")).toBe("Custom deploy tool");
    expect(toolActivityText("custom_deploy_tool")).toBe("Custom deploy tool");
    expect(toolRowLabel("Fetch data", false)).toBe("Fetch data");
  });

  it("translates the drawer row and the status sentence", () => {
    applyLocale("fr");
    expect(toolActivityText("read_file", { path: "a.txt" })).toBe("Lecture de fichiers");
    expect(toolActivitySentenceText("read_file", { path: "a.txt" })).toBe("Lecture de fichiers.");
    expect(toolActivitySentenceText(undefined)).toBe("Utilisation d'un outil.");
  });

  it("reads exactly as before in English", () => {
    applyLocale("en");
    expect(toolRowLabel("Searching web", false)).toBe("Searched the web");
    expect(toolActivitySentenceText(undefined)).toBe("Using a tool.");
  });
});
