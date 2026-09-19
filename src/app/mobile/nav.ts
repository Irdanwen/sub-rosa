import { useCallback, useMemo, useState } from "react";

/**
 * Mobile navigation model: a bottom tab bar plus one push stack per tab,
 * mirroring the standard iPhone navigation shape. View discriminants reuse
 * the desktop vocabulary from `app/tabs/tabs.ts` (meetings = note detail,
 * folders, agent, dictation, studio, settings) so deep links and future
 * state sharing stay coherent across shells.
 */
export type MobileTab = "notes" | "dictation" | "agent" | "studio" | "settings";

/** The settings detail screens the root list pushes to. */
export type SettingsSection =
  | "account"
  | "memory"
  | "connection"
  | "usage"
  | "privacy"
  | "archive"
  | "reports"
  | "models"
  | "about";

export type MobileRoute =
  | { view: "note"; noteId: string }
  | { view: "folder"; folderId: string }
  | { view: "agent-session"; sessionId?: string }
  | { view: "agent-history" }
  | { view: "settings-section"; section: SettingsSection };

export type MobileNav = {
  tab: MobileTab;
  /** Push stacks, one per tab, so switching tabs preserves depth. */
  stacks: Record<MobileTab, MobileRoute[]>;
};

const EMPTY_STACKS: Record<MobileTab, MobileRoute[]> = {
  notes: [],
  dictation: [],
  agent: [],
  studio: [],
  settings: [],
};

/**
 * The app opens on Chat. It is the one screen that is useful before you have
 * done anything — it asks a question rather than showing an empty list — and it
 * is the surface the rest of the app feeds. Notes is one tap away and keeps its
 * own stack, so nothing is further from reach than it was.
 */
export function useMobileNav(initialTab: MobileTab = "agent") {
  const [nav, setNav] = useState<MobileNav>({ tab: initialTab, stacks: EMPTY_STACKS });

  const switchTab = useCallback((tab: MobileTab) => {
    setNav((current) => {
      if (current.tab === tab) {
        // Re-tapping the active tab pops to its root, the platform convention.
        return { ...current, stacks: { ...current.stacks, [tab]: [] } };
      }
      return { ...current, tab };
    });
  }, []);

  const push = useCallback((route: MobileRoute) => {
    setNav((current) => ({
      ...current,
      stacks: {
        ...current.stacks,
        [current.tab]: [...current.stacks[current.tab], route],
      },
    }));
  }, []);

  const pop = useCallback(() => {
    setNav((current) => ({
      ...current,
      stacks: {
        ...current.stacks,
        [current.tab]: current.stacks[current.tab].slice(0, -1),
      },
    }));
  }, []);

  const replaceTop = useCallback((route: MobileRoute) => {
    setNav((current) => {
      const stack = current.stacks[current.tab];
      return {
        ...current,
        stacks: {
          ...current.stacks,
          [current.tab]: [...stack.slice(0, -1), route],
        },
      };
    });
  }, []);

  const top = nav.stacks[nav.tab].at(-1);
  const depth = nav.stacks[nav.tab].length;

  return useMemo(
    () => ({ tab: nav.tab, top, depth, switchTab, push, pop, replaceTop }),
    [nav.tab, top, depth, switchTab, push, pop, replaceTop],
  );
}

export type MobileNavHandle = ReturnType<typeof useMobileNav>;
