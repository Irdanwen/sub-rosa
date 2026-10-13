import { describe, expect, it } from "vitest";
import { readablePreview } from "../components/notes-list/NotesList";

describe("a note's preview line", () => {
  it("drops a heading that repeats the title", () => {
    expect(
      readablePreview(
        "Planchette d'essai pavage",
        "# Planchette d'essai pavage\n\nLes joints sont trop larges sur la zone B.",
      ),
    ).toBe("Les joints sont trop larges sur la zone B.");
  });

  it("reads list and quote markers as plain words", () => {
    expect(readablePreview("Idée", "- une équipe\n- une autre\n> à voir")).toBe(
      "une équipe une autre à voir",
    );
  });

  it("leaves the words alone, emphasis marks aside", () => {
    expect(readablePreview("", "Garder **10 %** de réserve")).toBe("Garder 10 % de réserve");
  });

  it("is empty when there is nothing but the title", () => {
    expect(readablePreview("Budget", "# Budget")).toBe("");
  });
});
