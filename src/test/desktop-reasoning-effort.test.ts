import { afterEach, describe, expect, it } from "vitest";
import { priceFor } from "../lib/carpe-diem-text-pricing";
import {
  desktopReasoningEffortFor,
  desktopRuntimeModel,
  modelSupportsReasoningEffort,
  parseReasoningEffortAlias,
  REASONING_EFFORT_ALIAS_MARKER,
  setDesktopReasoningEffort,
  stripReasoningEffortAlias,
  withReasoningEffortAlias,
} from "../lib/desktop-reasoning-effort";
import { normalizeHermesSessionsResponse } from "../lib/hermes-adapter";
import { parseSessionUsage } from "../lib/hermes-session-usage";
import { readableModelName } from "../lib/model-names";
import type { VeniceModelDto } from "../lib/tauri";

const PREFERENCE_KEY = "os-june:desktop-reasoning-effort";

function model(id: string, capabilities: string[]): VeniceModelDto {
  return {
    provider: "venice",
    id,
    name: id === "zai-org-glm-5-2" ? "GLM 5.2" : id,
    modelType: "text",
    traits: [],
    capabilities,
  };
}

const capable = model("zai-org-glm-5-2", ["supportsFunctionCalling", "supportsReasoningEffort"]);
const thinksOnly = model("kimi-k2-6", ["supportsFunctionCalling", "supportsReasoning"]);

afterEach(() => window.localStorage.removeItem(PREFERENCE_KEY));

describe("the reasoning-effort alias", () => {
  it("round-trips a model id and its effort", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const alias = withReasoningEffortAlias("zai-org-glm-5-2", effort);
      expect(alias).toBe(`zai-org-glm-5-2${REASONING_EFFORT_ALIAS_MARKER}${effort}`);
      expect(parseReasoningEffortAlias(alias)).toEqual({ modelId: "zai-org-glm-5-2", effort });
      expect(stripReasoningEffortAlias(alias)).toBe("zai-org-glm-5-2");
    }
  });

  it("is the bare id without an effort, and never stacks", () => {
    expect(withReasoningEffortAlias("zai-org-glm-5-2", undefined)).toBe("zai-org-glm-5-2");
    const once = withReasoningEffortAlias("zai-org-glm-5-2", "low");
    expect(withReasoningEffortAlias(once, "high")).toBe("zai-org-glm-5-2@reasoning-effort=high");
    expect(withReasoningEffortAlias(once, undefined)).toBe("zai-org-glm-5-2");
  });

  it("leaves real ids alone and drops an effort it does not know", () => {
    // Real catalog ids carry dots, dashes and slashes, never the marker.
    for (const id of ["llama-3.3-70b", "openai/gpt-oss-120b", "qwen3-235b-a22b-instruct-2507"]) {
      expect(parseReasoningEffortAlias(id)).toEqual({ modelId: id });
    }
    expect(parseReasoningEffortAlias("kimi-k2-6@reasoning-effort=turbo")).toEqual({
      modelId: "kimi-k2-6",
    });
    // A marker with no model before it names nothing: not an alias.
    expect(parseReasoningEffortAlias("@reasoning-effort=high")).toEqual({
      modelId: "@reasoning-effort=high",
    });
    expect(stripReasoningEffortAlias(undefined)).toBeUndefined();
  });

  it("is offered only where the catalog says the effort is supported", () => {
    expect(modelSupportsReasoningEffort(capable)).toBe(true);
    expect(modelSupportsReasoningEffort(thinksOnly)).toBe(false);
    expect(modelSupportsReasoningEffort(undefined)).toBe(false);
    expect(
      modelSupportsReasoningEffort({ capabilities: ["capabilities.supportsReasoningEffort"] }),
    ).toBe(true);
  });

  it("keeps the choice per model and hands the runtime the alias only for a capable model", () => {
    expect(desktopRuntimeModel("zai-org-glm-5-2", [capable, thinksOnly])).toBe("zai-org-glm-5-2");

    setDesktopReasoningEffort("zai-org-glm-5-2", "high");
    setDesktopReasoningEffort("kimi-k2-6", "low");

    expect(desktopReasoningEffortFor("zai-org-glm-5-2@reasoning-effort=low")).toBe("high");
    expect(desktopRuntimeModel("zai-org-glm-5-2", [capable, thinksOnly])).toBe(
      "zai-org-glm-5-2@reasoning-effort=high",
    );
    // A stored choice never reaches a model that cannot take it, nor a model
    // the catalog does not know yet.
    expect(desktopRuntimeModel("kimi-k2-6", [capable, thinksOnly])).toBe("kimi-k2-6");
    expect(desktopRuntimeModel("zai-org-glm-5-2", [])).toBe("zai-org-glm-5-2");

    setDesktopReasoningEffort("zai-org-glm-5-2", undefined);
    expect(desktopRuntimeModel("zai-org-glm-5-2", [capable])).toBe("zai-org-glm-5-2");
  });

  it("survives unreadable storage", () => {
    window.localStorage.setItem(PREFERENCE_KEY, "{not json");
    expect(desktopReasoningEffortFor("zai-org-glm-5-2")).toBeUndefined();
    window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ "zai-org-glm-5-2": "ultra" }));
    expect(desktopReasoningEffortFor("zai-org-glm-5-2")).toBeUndefined();
  });
});

describe("the alias never reaches what a person reads or pays", () => {
  const alias = "zai-org-glm-5-2@reasoning-effort=high";

  it("is stripped from the session list Hermes reports", () => {
    const [session] = normalizeHermesSessionsResponse({
      sessions: [{ id: "s1", model: alias, title: "Plan", last_active: "2026-10-07T10:00:00Z" }],
    });
    expect(session?.model).toBe("zai-org-glm-5-2");
  });

  it("is stripped from the session usage panel", () => {
    expect(parseSessionUsage("s1", { model: alias, prompt_tokens: 10 }).model).toBe(
      "zai-org-glm-5-2",
    );
  });

  it("prices and names the real model", () => {
    const prices = [{ model: "zai-org-glm-5-2", inputUsdPerMtok: 1.75, outputUsdPerMtok: 5.5 }];
    expect(priceFor(alias, prices)).toBe(prices[0]);
    expect(readableModelName(alias, "GLM 5.2")).toBe("GLM 5.2");
    expect(readableModelName(alias)).not.toContain("effort");
  });
});
