import { describe, expect, it } from "vitest";
import { SETTINGS_TABS } from "../components/settings/AppSettings";
import { SETTINGS_GROUPS as SETTINGS_SIDEBAR_GROUPS } from "../components/settings/settings-index";

/**
 * Settings used to live in two lists that had to agree; since 2026-10-12 the
 * flat list is derived from the groups (settings-index.tsx), and these
 * checks keep the derivation honest.
 *
 * `SETTINGS_TABS` is what the settings page can render; `SETTINGS_SIDEBAR_GROUPS`
 * is what the sidebar offers, and it is now also what the command palette
 * indexes. A tab added to one and forgotten in the other is not a broken build
 * and not a failing render -- it is a setting that exists and cannot be found,
 * which is exactly how this surface grew to twenty-five entries with twelve of
 * them reachable only by knowing they were there.
 *
 * Twelve tabs were once hidden from the nav "while they stabilised", and
 * stayed hidden for two months. On 2026-09-03 five came back (MCP servers,
 * MCP security, MCP diagnostics, toolsets, import / export) and seven were
 * deleted with their code. So the rule is simple again: every tab the page
 * can render is in a group, and the searchable surface is the visible one.
 */
describe("the settings index", () => {
  const grouped = SETTINGS_SIDEBAR_GROUPS.flatMap((group) => group.items);
  const groupedIds = new Set(grouped.map((item) => item.id));

  it("places every settings tab in a group", () => {
    const missing = SETTINGS_TABS.filter((tab) => !groupedIds.has(tab.id)).map((tab) => tab.id);

    expect(missing).toEqual([]);
  });

  it("groups no tab the settings page cannot render", () => {
    const known = new Set(SETTINGS_TABS.map((tab) => tab.id));
    const orphans = grouped.filter((item) => !known.has(item.id)).map((item) => item.id);

    expect(orphans).toEqual([]);
  });

  it("lists each tab exactly once", () => {
    const seen = new Map<string, number>();
    for (const item of grouped) seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
    const duplicated = [...seen].filter(([, count]) => count > 1).map(([id]) => id);

    expect(duplicated).toEqual([]);
  });

  it("keeps the searchable surface equal to the visible one", () => {
    // Nothing is hidden any more: the count is the count. It is asserted so
    // that adding a tab is a decision taken here, not a number drifting.
    expect(grouped).toHaveLength(SETTINGS_TABS.length);
    expect(SETTINGS_TABS).toHaveLength(24);
  });

  it("keeps four groups a person reads, and folds only Advanced (ADR-0110)", () => {
    expect(SETTINGS_SIDEBAR_GROUPS.filter((group) => !group.folded)).toHaveLength(4);
    expect(
      SETTINGS_SIDEBAR_GROUPS.filter((group) => group.folded).map((group) => group.id),
    ).toEqual(["advanced"]);
  });

  it("gives every tab a label a person would type", () => {
    // The palette searches the label, so an empty or one-letter label is a tab
    // nobody can reach by name. A label that matches its own group ("Audio" in
    // Audio) is fine -- that is what the thing is called.
    for (const group of SETTINGS_SIDEBAR_GROUPS) {
      for (const item of group.items) {
        expect(item.label.trim().length).toBeGreaterThan(2);
      }
    }
  });
});
