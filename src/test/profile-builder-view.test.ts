import { describe, expect, it } from "vitest";
import {
  attachableMcpServers,
  buildCreatePayload,
  buildCreatePlan,
  bundledSkillOptions,
  canAdvance,
  canCreateProfile,
  emptyProfileForm,
  installableCatalogEntries,
  modelSupportsToolCalling,
  nextStep,
  PROFILE_BUILDER_STEPS,
  type ProfileBuilderContext,
  type ProfileBuilderForm,
  type ProfileBuilderModel,
  previousStep,
  selectedModelToolSupport,
  slugifyProfileName,
  STEP_META,
  validateProfileName,
  validateStep,
} from "../lib/hermes-admin/profile-builder-view";
import type {
  HermesMcpCatalogEntry,
  HermesMcpServerInfo,
  HermesSkillInfo,
} from "../lib/hermes-admin/schemas";

const toolModel: ProfileBuilderModel = {
  provider: "carpe-diem",
  id: "tools",
  name: "Tools",
  capabilities: ["Function_Calling"],
};
const plainModel: ProfileBuilderModel = {
  provider: "carpe-diem",
  id: "plain",
  name: "Plain",
  capabilities: ["vision"],
};

const context: ProfileBuilderContext = {
  existingProfiles: [{ name: "Research", raw: {} }],
  models: [toolModel, plainModel],
};

function form(overrides: Partial<ProfileBuilderForm> = {}): ProfileBuilderForm {
  return { ...emptyProfileForm(), ...overrides };
}

describe("profile names", () => {
  it("slugifies to a conservative charset", () => {
    expect(slugifyProfileName("  My Coder / Agent!  ")).toBe("my-coder-agent");
    expect(slugifyProfileName("dev_ops")).toBe("dev-ops");
    expect(slugifyProfileName("éé")).toBe("");
  });

  it("rejects empty, unusable, long, reserved and taken names", () => {
    expect(validateProfileName("   ", [])).toBe("Enter a profile name.");
    expect(validateProfileName("!!!", [])).toBe("Use letters or numbers in the profile name.");
    expect(validateProfileName("a".repeat(65), [])).toBe(
      "Keep the profile name under 64 characters.",
    );
    expect(validateProfileName("Default", [])).toBe('"default" is reserved. Choose another name.');
    expect(validateProfileName("research", context.existingProfiles)).toBe(
      'A profile named "research" already exists.',
    );
    expect(validateProfileName("Writer", context.existingProfiles)).toBeUndefined();
  });
});

describe("the tool-calling gate", () => {
  it("recognizes tool calling however the capability is spelled", () => {
    expect(modelSupportsToolCalling(toolModel)).toBe(true);
    expect(modelSupportsToolCalling({ ...plainModel, capabilities: ["tool calling"] })).toBe(true);
    expect(modelSupportsToolCalling(plainModel)).toBe(false);
  });

  it("matches the selected model on provider and id", () => {
    expect(selectedModelToolSupport(form(), context.models)).toBeUndefined();
    expect(
      selectedModelToolSupport(form({ provider: "other", model: "tools" }), context.models),
    ).toBeUndefined();
    expect(
      selectedModelToolSupport(form({ provider: "carpe-diem", model: "plain" }), context.models),
    ).toEqual({ model: plainModel, supportsTools: false });
  });
});

describe("validateStep", () => {
  it("warns a specialized role with no instructions, without blocking", () => {
    const result = validateStep(
      "identity",
      form({ name: "Writer", identity: "specialized" }),
      context,
    );
    expect(result.error).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(
      validateStep(
        "identity",
        form({ name: "Writer", identity: "specialized", soul: "Be terse" }),
        context,
      ).warnings,
    ).toEqual([]);
  });

  it("blocks the model step without a model or on a model that cannot call tools", () => {
    expect(validateStep("model", form(), context).error).toBe("Choose a generation model.");
    expect(
      validateStep("model", form({ provider: "carpe-diem", model: "plain" }), context).error,
    ).toMatch(/does not support tool calling/);
    const unknown = validateStep("model", form({ provider: "x", model: "y" }), context);
    expect(unknown.error).toBeUndefined();
    expect(unknown.warnings[0]).toMatch(/could not be confirmed/);
  });

  it("warns, never blocks, on the optional steps", () => {
    expect(
      validateStep("toolsets", form({ sandbox: "unrestricted" }), context).warnings,
    ).toHaveLength(1);
    expect(validateStep("toolsets", form(), context).warnings).toEqual([]);
    expect(validateStep("skills", form(), context)).toEqual({ error: undefined, warnings: [] });
    expect(
      validateStep("mcps", form({ mcpCatalogInstalls: ["github"] }), context).warnings,
    ).toHaveLength(1);
    expect(
      validateStep(
        "mcps",
        form({ sandbox: "unrestricted", mcpCatalogInstalls: ["github"] }),
        context,
      ).warnings,
    ).toEqual([]);
  });

  it("re-runs both gates on review so a late edit cannot slip through", () => {
    const good = form({ name: "Writer", provider: "carpe-diem", model: "tools" });
    expect(validateStep("review", good, context).error).toBeUndefined();
    expect(canCreateProfile(good, context)).toBe(true);
    const badName = { ...good, name: "default" };
    expect(validateStep("review", badName, context).error).toMatch(/reserved/);
    const badModel = { ...good, model: "plain" };
    expect(canAdvance("review", badModel, context)).toBe(false);
    expect(canCreateProfile(badModel, context)).toBe(false);
  });
});

describe("step navigation", () => {
  it("walks the steps and stops at both ends", () => {
    expect(nextStep("identity")).toBe("model");
    expect(nextStep("review")).toBe("review");
    expect(previousStep("model")).toBe("identity");
    expect(previousStep("identity")).toBe("identity");
    for (const step of PROFILE_BUILDER_STEPS) {
      expect(STEP_META[step].title).not.toMatch(/[–—]/);
    }
  });
});

describe("buildCreatePlan", () => {
  it("lists only info changes for the safe default", () => {
    const plan = buildCreatePlan(form({ name: "Writer", model: "tools" }));
    expect(plan.map((change) => change.target)).toEqual([
      "~/.hermes/profiles/writer/",
      "~/.hermes/profiles/writer/config.yaml",
      "~/.hermes/profiles/writer/skills/",
    ]);
    expect(plan.every((change) => change.risk === "info")).toBe(true);
    expect(plan[1].detail).toContain("keeps Sub Rosa's identity");
  });

  it("labels every riskier choice", () => {
    const plan = buildCreatePlan(
      form({
        identity: "specialized",
        soul: "Be terse",
        keepSkills: ["a", "b"],
        hubSkills: ["hub/x"],
        mcpServers: ["linear"],
        mcpCatalogInstalls: ["github"],
        sandbox: "unrestricted",
      }),
    );
    expect(plan[0].target).toBe("~/.hermes/profiles/<profile>/");
    expect(plan[1].detail).toContain("(unset)");
    expect(plan.map((change) => change.risk)).toEqual([
      "info",
      "info",
      "caution",
      "info",
      "caution",
      "caution",
      "danger",
    ]);
    expect(plan[3].detail).toContain("Copies 2 bundled skill(s)");
    expect(plan[5].detail).toContain("Attaches 2 MCP server(s)");
  });

  it("says when no skills are copied", () => {
    const plan = buildCreatePlan(form({ name: "Bare", keepBundledSkills: false }));
    expect(plan[2].detail).toMatch(/Starts with no skills/);
  });
});

describe("buildCreatePayload", () => {
  it("keeps the body minimal for the default form", () => {
    expect(buildCreatePayload(form({ name: "Writer" }))).toEqual({
      name: "writer",
      clone_from_default: true,
      no_skills: false,
    });
  });

  it("carries every choice, and never the SOUL", () => {
    const payload = buildCreatePayload(
      form({
        name: "Writer",
        description: "  Long form  ",
        soul: "secret instructions",
        provider: "carpe-diem",
        model: "tools",
        keepSkills: ["a"],
        hubSkills: ["hub/x"],
        mcpServers: ["linear"],
        mcpCatalogInstalls: ["github"],
      }),
    );
    expect(payload).toEqual({
      name: "writer",
      clone_from_default: true,
      no_skills: false,
      description: "Long form",
      provider: "carpe-diem",
      model: "tools",
      keep_skills: ["a"],
      hub_skills: ["hub/x"],
      mcp_servers: [{ name: "linear" }, { name: "github" }],
    });
    expect(JSON.stringify(payload)).not.toContain("secret instructions");
  });

  it("drops the kept-skill list when bundled skills are not copied", () => {
    const payload = buildCreatePayload(
      form({ name: "Bare", keepBundledSkills: false, keepSkills: ["a"] }),
    );
    expect(payload).toEqual({ name: "bare", clone_from_default: false, no_skills: true });
  });
});

describe("selectable inputs", () => {
  it("offers bundled skills, every server, and catalog entries not yet installed", () => {
    const skills: HermesSkillInfo[] = [
      { name: "a", enabled: true, source: "bundled", raw: {} },
      { name: "b", enabled: true, source: "hub", raw: {} },
    ];
    expect(bundledSkillOptions(skills).map((skill) => skill.name)).toEqual(["a"]);

    const servers: HermesMcpServerInfo[] = [
      { name: "s", enabled: false, transport: "stdio", auth: "not-required", raw: {} },
    ];
    const attachable = attachableMcpServers(servers);
    expect(attachable).toEqual(servers);
    expect(attachable).not.toBe(servers);

    const entry = (installName: string, installed?: boolean): HermesMcpCatalogEntry => ({
      id: installName,
      installName,
      name: installName,
      transport: "stdio",
      auth: "none",
      installed,
      raw: {},
    });
    expect(
      installableCatalogEntries([entry("x", true), entry("y"), entry("z", false)]).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["y", "z"]);
  });
});
