import { describe, expect, it, vi } from "vitest";
// @ts-expect-error: a plain ES module script without types.
import { collectRustSentences, sentencesIn } from "../../scripts/i18n/rust-sentences.mjs";
import fr from "../locales/fr.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/**
 * Rust renders its own notifications from the French catalog (ADR-0047
 * addendum). The extractor has to see every `tr!("…")` for the catalog gate
 * to hold, and the webview has to tell Rust the language it chose.
 */
describe("the Rust sentence extractor", () => {
  it("picks tr! literals, with or without placeholders, and AppError literals", () => {
    const source = [
      '.title(crate::tr!("Your day"))',
      'crate::tr!("{count} meetings", count = count)',
      'tr!(\n    "Wrapped onto the next line",\n)',
      'AppError::new("assignment_not_found", "That assignment no longer exists.")',
      'AppError::new("x", "no_speech")',
      '/// crate::tr!("A doc comment is not a sentence")',
      '    // tr!("Neither is a comment")',
      'format!("{} is ready", title)',
    ].join("\n");
    expect([...sentencesIn(source)].sort()).toEqual(
      [
        "{count} meetings",
        "That assignment no longer exists.",
        "Wrapped onto the next line",
        "Your day",
      ].sort(),
    );
  });

  it("finds the notification sentences in the Rust source, each translated", () => {
    const sentences: string[] = collectRustSentences();
    const catalog = fr as Record<string, string>;
    for (const sentence of [
      "Your day",
      "Your next meeting",
      "Your research report is ready in your notes.",
      "This run did not finish. {reason}",
      "{count} results to review",
    ]) {
      expect(sentences).toContain(sentence);
      expect(catalog[sentence]).toBeTruthy();
    }
  });
});

describe("telling Rust the language", () => {
  it("sends the resolved locale inside the app, and nothing outside it", async () => {
    const { tellNativeLocale } = await import("../lib/i18n-native");
    invoke.mockResolvedValue(undefined);
    await tellNativeLocale("fr");
    expect(invoke).not.toHaveBeenCalled();

    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
    try {
      await tellNativeLocale("fr");
      expect(invoke).toHaveBeenCalledWith("i18n_set_locale", { locale: "fr" });
      invoke.mockRejectedValueOnce(new Error("no command"));
      await expect(tellNativeLocale("en")).resolves.toBeUndefined();
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    }
  });
});
