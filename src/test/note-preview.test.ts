import { describe, expect, it } from "vitest";
import { readablePreview } from "../lib/note-preview";

describe("readablePreview", () => {
  it("drops a heading that restates the title", () => {
    expect(readablePreview("# Mes livres\n\nLivres lus : - Game of Thrones", "Mes livres")).toBe(
      "Livres lus : - Game of Thrones",
    );
  });

  it("keeps a heading that says something else, without its markup", () => {
    expect(readablePreview("# Livres lus\n- **Dune** : 9/10", "Mes livres")).toBe(
      "Livres lus Dune : 9/10",
    );
  });

  it("reads links, code and emphasis as their text", () => {
    expect(readablePreview("Voir [le site](https://x.y) et `npm` *vite*", "")).toBe(
      "Voir le site et npm vite",
    );
  });

  it("ignores fences, tables and rules", () => {
    expect(readablePreview("```\ncode\n```\n| a | b |\n---\nFin", "Note")).toBe("Fin");
  });

  it("tolerates a truncated title heading", () => {
    expect(readablePreview("# Exposé biblique :", "Exposé biblique")).toBe("");
  });
});
