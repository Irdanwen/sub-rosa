import { describe, expect, it } from "vitest";
import {
  catalogAuthMeta,
  catalogHaystack,
  catalogStatusMeta,
  catalogStatusOf,
  emptyInstallDraft,
  envRequirementsFor,
  filterCatalog,
  isLocalSubprocessEntry,
  needsAuthHandoff,
  needsCredentials,
  validateInstallDraft,
} from "../lib/hermes-admin/mcp-catalog-view";
import type { HermesMcpCatalogEntry } from "../lib/hermes-admin/schemas";

function entry(overrides: Partial<HermesMcpCatalogEntry> = {}): HermesMcpCatalogEntry {
  return {
    id: "github",
    installName: "github-mcp",
    name: "GitHub",
    transport: "stdio",
    auth: "api-key",
    requiredEnv: [
      { key: "GITHUB_TOKEN", label: "GitHub token" },
      { key: "GITHUB_HOST", required: false },
    ],
    raw: {},
    ...overrides,
  };
}

describe("catalog labels", () => {
  it("tells a local subprocess from a remote server", () => {
    expect(isLocalSubprocessEntry(entry())).toBe(true);
    expect(isLocalSubprocessEntry(entry({ transport: "http-oauth" }))).toBe(false);
  });

  it("has sentence-case auth labels with a tone", () => {
    expect(catalogAuthMeta("api-key")).toMatchObject({ label: "API key", tone: "attention" });
    expect(catalogAuthMeta("none")).toMatchObject({ label: "No auth", tone: "neutral" });
  });

  it("derives the install status", () => {
    expect(catalogStatusOf(entry())).toBe("available");
    expect(catalogStatusOf(entry({ installed: true, enabled: false }))).toBe("installed-disabled");
    expect(catalogStatusOf(entry({ installed: true }))).toBe("enabled");
    expect(catalogStatusMeta("enabled")).toEqual({
      status: "enabled",
      label: "Enabled",
      tone: "ok",
    });
    expect(catalogStatusMeta("installed-disabled").label).toBe("Installed, disabled");
  });
});

describe("install drafts", () => {
  it("seeds one blank field per required env key", () => {
    expect(emptyInstallDraft(entry())).toEqual({
      enable: true,
      env: { GITHUB_TOKEN: "", GITHUB_HOST: "" },
    });
    expect(emptyInstallDraft(entry({ requiredEnv: undefined }))).toEqual({ enable: true, env: {} });
  });

  it("collects nothing for an entry whose auth runs after install", () => {
    const oauth = entry({ auth: "oauth" });
    expect(envRequirementsFor(oauth)).toEqual([]);
    expect(needsCredentials(oauth)).toBe(false);
    expect(needsAuthHandoff(oauth)).toBe(true);
    expect(needsAuthHandoff(entry({ auth: "third-party" }))).toBe(true);
    expect(needsAuthHandoff(entry())).toBe(false);
  });

  it("needs credentials only when a requirement is not optional", () => {
    expect(needsCredentials(entry())).toBe(true);
    expect(needsCredentials(entry({ requiredEnv: [{ key: "X", required: false }] }))).toBe(false);
    expect(needsCredentials(entry({ requiredEnv: undefined }))).toBe(false);
  });

  it("names every missing required value and sends nothing", () => {
    const result = validateInstallDraft(entry(), {
      enable: true,
      env: { GITHUB_TOKEN: "   " },
    });
    expect(result).toEqual({
      ok: false,
      errors: { GITHUB_TOKEN: "Enter a value for GitHub token." },
    });
    const unlabeled = validateInstallDraft(entry({ requiredEnv: [{ key: "API_KEY" }] }), {
      enable: true,
      env: {},
    });
    expect(unlabeled).toEqual({ ok: false, errors: { API_KEY: "Enter a value for API_KEY." } });
  });

  it("builds a minimal payload, dropping blank optional values", () => {
    expect(
      validateInstallDraft(entry(), { enable: true, env: { GITHUB_TOKEN: "t", GITHUB_HOST: "" } }),
    ).toEqual({ ok: true, payload: { name: "github-mcp", env: { GITHUB_TOKEN: "t" } } });
    expect(
      validateInstallDraft(entry({ auth: "none", requiredEnv: [] }), { enable: false, env: {} }),
    ).toEqual({ ok: true, payload: { name: "github-mcp", enable: false } });
  });
});

describe("catalog search", () => {
  const catalog = [
    entry(),
    entry({
      id: "linear",
      installName: "linear",
      name: "Linear",
      transport: "http-oauth",
      auth: "oauth",
      description: "Issues",
      source: "official",
      defaultTools: ["create_issue"],
    }),
  ];

  it("searches names, labels, sources and tool names", () => {
    expect(catalogHaystack(catalog[1])).toContain("create_issue");
    expect(filterCatalog(catalog, "  ").map((item) => item.id)).toEqual(["github", "linear"]);
    expect(filterCatalog(catalog, "CREATE_ISSUE").map((item) => item.id)).toEqual(["linear"]);
    expect(filterCatalog(catalog, "api key").map((item) => item.id)).toEqual(["github"]);
    expect(filterCatalog(catalog, "official").map((item) => item.id)).toEqual(["linear"]);
    expect(filterCatalog(catalog, "nothing")).toEqual([]);
  });
});
