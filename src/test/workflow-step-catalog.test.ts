// The steps a workflow can hold, as the assistant reads them (ADR-0120):
// a JSON snapshot of the schema that Rust embeds, kept equal to the schema
// here. When a step changes, regenerate it with
//   pnpm vitest run src/test/workflow-step-catalog.test.ts -u
// (the file is generated, so Biome leaves its formatting alone).

import { describe, expect, it } from "vitest";
import { stepCatalog } from "../lib/studio/workflow/step-catalog";

describe("the step catalog the assistant reads", () => {
  it("is the schema, as committed", async () => {
    await expect(`${JSON.stringify(stepCatalog(), null, 2)}\n`).toMatchFileSnapshot(
      "../lib/studio/workflow/step-catalog.json",
    );
  });

  it("leaves out the steps only the app makes", () => {
    const types = stepCatalog().map((step) => step.type);
    expect(types).not.toContain("block");
    expect(types).not.toContain("listItem");
    expect(types).toContain("image");
  });
});
