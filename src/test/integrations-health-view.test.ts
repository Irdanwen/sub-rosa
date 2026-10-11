import { describe, expect, it } from "vitest";
import type { ExternalDirRow } from "../lib/hermes-admin/external-dirs-view";
import type { GatewayLifecycleSnapshot } from "../lib/hermes-admin/gateway-lifecycle";
import {
  buildIntegrationsHealth,
  buildIntegrationsHealthReport,
  healthStatusLabel,
  type IntegrationsHealthInputs,
  integrationsHealthReportFilename,
  serializeIntegrationsHealthReport,
} from "../lib/hermes-admin/integrations-health-view";
import type { HermesMcpServerInfo, HermesToolsetInfo } from "../lib/hermes-admin/schemas";

function lifecycle(
  state: GatewayLifecycleSnapshot["state"],
  error?: string,
): GatewayLifecycleSnapshot {
  return { state, label: state, detail: "", canRestart: true, error };
}

function server(overrides: Partial<HermesMcpServerInfo>): HermesMcpServerInfo {
  return {
    name: "server",
    enabled: true,
    transport: "stdio",
    auth: "not-required",
    raw: {},
    ...overrides,
  };
}

function toolset(overrides: Partial<HermesToolsetInfo>): HermesToolsetInfo {
  return { name: "toolset", enabled: true, raw: {}, ...overrides };
}

function dir(rawPath: string, presence: ExternalDirRow["presence"]): ExternalDirRow {
  return {
    rawPath,
    expanded: false,
    presence,
    writability: "unknown",
    skillNames: [],
    shadowedByLocal: [],
    readOnlyInJune: true,
  };
}

function inputs(overrides: Partial<IntegrationsHealthInputs> = {}): IntegrationsHealthInputs {
  return {
    lifecycle: lifecycle("clean"),
    skills: [],
    toolsets: [],
    mcpServers: [],
    pendingSkillWrites: 0,
    externalDirs: [],
    ...overrides,
  };
}

describe("buildIntegrationsHealth", () => {
  it("reads ready with no issues when nothing needs attention", () => {
    const health = buildIntegrationsHealth(
      inputs({ model: { id: "m", name: "Model", supportsTools: true } }),
    );
    expect(health.status).toBe("ready");
    expect(health.statusLabel).toBe("Ready");
    expect(health.tone).toBe("ready");
    expect(health.issues).toEqual([]);
    expect(health.unavailable).toBe(false);
  });

  it("reads unknown when no runtime is reachable, even with issues", () => {
    const health = buildIntegrationsHealth(
      inputs({ unavailable: true, mcpServers: [server({ status: "error" })] }),
    );
    expect(health.status).toBe("unknown");
    expect(health.tone).toBe("neutral");
    expect(health.issues.map((issue) => issue.code)).toEqual(["mcp-failing"]);
  });

  it("blocks on a model that cannot call tools, naming it", () => {
    const health = buildIntegrationsHealth(
      inputs({ model: { id: "plain", name: "Plain model", supportsTools: false } }),
    );
    expect(health.issues[0]).toMatchObject({ code: "model-no-tools", target: "models" });
    expect(health.issues[0].message).toContain("Plain model");
    expect(health.status).toBe("needs-setup");
  });

  it("falls back to the id when a no-tools model has no name", () => {
    const health = buildIntegrationsHealth(
      inputs({ model: { id: "raw-id", supportsTools: false } }),
    );
    expect(health.issues[0].message).toContain("raw-id");
  });

  it("flags a missing model and stays silent on an unknown capability", () => {
    expect(buildIntegrationsHealth(inputs({ model: { id: "" } })).issues[0].code).toBe(
      "model-unknown",
    );
    expect(buildIntegrationsHealth(inputs({ model: { id: "loading" } })).issues).toEqual([]);
  });

  it("reports a failed restart with its own error, or a default sentence", () => {
    const withError = buildIntegrationsHealth(
      inputs({ lifecycle: lifecycle("restart-failed", "Port in use") }),
    );
    expect(withError.issues[0]).toMatchObject({
      code: "gateway-restart-failed",
      message: "Port in use",
    });
    expect(withError.status).toBe("broken");
    const without = buildIntegrationsHealth(inputs({ lifecycle: lifecycle("restart-failed") }));
    expect(without.issues[0].message).toMatch(/did not restart/);
  });

  it("asks for a restart while one is pending, but not while it runs", () => {
    const pending = buildIntegrationsHealth(
      inputs({ lifecycle: lifecycle("gateway-restart-required") }),
    );
    expect(pending.issues.map((issue) => issue.code)).toEqual(["gateway-restart-required"]);
    expect(pending.status).toBe("needs-restart");
    expect(pending.summary.mcp.restartPending).toBe(true);

    const running = buildIntegrationsHealth(
      inputs({ lifecycle: lifecycle("restart-in-progress") }),
    );
    expect(running.issues).toEqual([]);
    expect(running.summary.mcp.restartPending).toBe(true);
  });

  it("only counts enabled skills with a missing secret or config", () => {
    const health = buildIntegrationsHealth(
      inputs({
        skills: [
          {
            name: "linear",
            enabled: true,
            badge: { status: "missing-api-key", label: "", tone: "attention" },
          },
          {
            name: "notion",
            enabled: true,
            badge: { status: "missing-config", label: "", tone: "attention" },
          },
          {
            name: "off",
            enabled: false,
            badge: { status: "missing-api-key", label: "", tone: "attention" },
          },
          { name: "fine", enabled: true, badge: { status: "ready", label: "", tone: "ready" } },
          { name: "bare", enabled: true },
        ],
      }),
    );
    expect(health.issues.map((issue) => [issue.code, issue.message.includes("linear")])).toEqual([
      ["skill-missing-secret", true],
      ["skill-missing-config", false],
    ]);
    expect(health.summary.skills).toEqual({ total: 5, enabled: 4, needingSetup: 2 });
  });

  it("pluralizes pending skill writes", () => {
    const one = buildIntegrationsHealth(inputs({ pendingSkillWrites: 1 }));
    expect(one.issues[0].message).toBe("1 agent-authored skill change await your review.");
    expect(one.status).toBe("needs-review");
    const two = buildIntegrationsHealth(inputs({ pendingSkillWrites: 2 }));
    expect(two.issues[0].message).toContain("2 agent-authored skill changes");
  });

  it("flags toolsets by the explicit flag or an unmet requirement, never a disabled one", () => {
    const health = buildIntegrationsHealth(
      inputs({
        toolsets: [
          toolset({ name: "web", label: "Web search", configured: false }),
          toolset({ name: "shell", requirements: [{ label: "bash", satisfied: false }] }),
          toolset({ name: "quiet", requirements: [{ label: "x" }] }),
          toolset({ name: "off", enabled: false, configured: false }),
        ],
      }),
    );
    expect(health.issues.map((issue) => issue.message)).toEqual([
      "The Web search toolset is enabled but its requirements are not met.",
      "The shell toolset is enabled but its requirements are not met.",
    ]);
    expect(health.summary.toolsets).toEqual({ total: 4, enabled: 3, needingSetup: 2 });
  });

  it("classifies MCP servers: failing, needing sign-in, high risk", () => {
    const health = buildIntegrationsHealth(
      inputs({
        mcpServers: [
          server({ name: "broken", status: "error" }),
          server({ name: "linear", transport: "http-oauth", auth: "unknown" }),
          server({ name: "expired", transport: "http", auth: "expired" }),
          server({ name: "public", transport: "http", auth: "unknown" }),
          server({ name: "open", transport: "http-oauth", auth: "not-required" }),
          server({ name: "signed", transport: "http-oauth", auth: "authenticated" }),
          server({ name: "risky" }),
          server({ name: "risky-off", enabled: false, status: "error" }),
        ],
        highRiskMcpServers: ["risky", "risky-off"],
      }),
    );
    expect(health.issues.map((issue) => `${issue.code}:${issue.message.split(" ")[1]}`)).toEqual([
      "mcp-failing:broken",
      "mcp-high-risk:risky",
      "mcp-auth-needed:linear",
      "mcp-auth-needed:expired",
    ]);
    expect(health.status).toBe("broken");
    expect(health.summary.highRiskMcp).toBe(1);
    expect(health.summary.mcp).toMatchObject({ total: 8, enabled: 7, disabled: 1, failing: 1 });
  });

  it("separates missing external directories from unreadable ones", () => {
    const health = buildIntegrationsHealth(
      inputs({
        externalDirs: [
          dir("/gone", "missing"),
          dir("/file", "not-a-directory"),
          dir("$NOPE/skills", "unresolved"),
          dir("/locked", "unreadable"),
          dir("/ok", "ok"),
        ],
      }),
    );
    expect(health.issues.map((issue) => issue.code)).toEqual([
      "external-dir-missing",
      "external-dir-missing",
      "external-dir-missing",
      "external-dir-unreadable",
    ]);
    expect(health.summary.externalDirs).toEqual({ total: 5, missing: 3, unreadable: 1 });
  });

  it("orders issues worst first, then by area, whatever the input order", () => {
    const health = buildIntegrationsHealth(
      inputs({
        model: { id: "plain", supportsTools: false },
        lifecycle: lifecycle("gateway-restart-required"),
        pendingSkillWrites: 3,
        mcpServers: [server({ name: "risky" })],
        highRiskMcpServers: ["risky"],
        externalDirs: [dir("/gone", "missing")],
      }),
    );
    expect(health.issues.map((issue) => issue.status)).toEqual([
      "broken",
      "risky-configuration",
      "needs-restart",
      "needs-setup",
      "needs-review",
    ]);
    expect(health.status).toBe("broken");
    expect(healthStatusLabel(health.status)).toBe("Broken");
  });

  it("defaults the secret counts to zero and keeps given ones", () => {
    expect(buildIntegrationsHealth(inputs()).summary.secrets).toEqual({
      configured: 0,
      missing: 0,
    });
    expect(
      buildIntegrationsHealth(inputs({ secrets: { configured: 4, missing: 1 } })).summary.secrets,
    ).toEqual({ configured: 4, missing: 1 });
  });
});

describe("buildIntegrationsHealthReport", () => {
  const now = new Date("2026-10-11T12:34:56.789Z");

  it("exports counts and safe copy, with the default mode and profile", () => {
    const health = buildIntegrationsHealth(
      inputs({
        model: { id: "m", name: "Model", supportsTools: true },
        secrets: { configured: 2, missing: 1 },
        pendingSkillWrites: 1,
      }),
    );
    const report = buildIntegrationsHealthReport(health, { now });
    expect(report).toMatchObject({
      generatedAt: "2026-10-11T12:34:56.789Z",
      mode: "sandboxed",
      profile: "default",
      status: "needs-review",
      statusLabel: "Needs review",
      model: { id: "m", name: "Model", supportsTools: true },
      gateway: { state: "clean" },
    });
    expect(report.summary.secrets).toEqual({ configured: 2, missing: 1 });
    expect(report.issues).toHaveLength(1);
    expect(JSON.parse(serializeIntegrationsHealthReport(report))).toEqual(report);
  });

  it("never lets a credential printed in a message leave the machine", () => {
    const token = "sk0123456789abcdefghijKLMN";
    const health = buildIntegrationsHealth(
      inputs({
        mode: "unrestricted",
        profile: "work",
        lifecycle: lifecycle("restart-failed", `Auth failed (${token}). See /var/log/a.log`),
      }),
    );
    const report = buildIntegrationsHealthReport(health, { now });
    const text = serializeIntegrationsHealthReport(report);
    expect(text).not.toContain(token);
    expect(report.issues[0].message).toContain("/var/log/a.log");
    expect(report.mode).toBe("unrestricted");
    expect(report.profile).toBe("work");
    expect(report.model).toBeUndefined();
  });

  it("names the download after a filesystem-safe profile and the time", () => {
    expect(integrationsHealthReportFilename("my profile/x", now)).toBe(
      "integrations-health-my-profile-x-2026-10-11T12-34-56-789Z.json",
    );
  });
});
