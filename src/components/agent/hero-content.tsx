import { t } from "../../lib/i18n";
import type { ReactNode } from "react";
import { IconHistory } from "central-icons/IconHistory";
import { IconDeepSearch } from "central-icons/IconDeepSearch";
import { IconFileSparkle } from "central-icons/IconFileSparkle";
import { IconHeartBeat } from "central-icons/IconHeartBeat";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPieChart1 } from "central-icons/IconPieChart1";
import { IconFileText } from "central-icons/IconFileText";
import { IconListBullets } from "central-icons/IconListBullets";

export type AgentShortcut = {
  key: string;
  icon: ReactNode;
  title: string;
  description: string;
  prompt: string;
  /**
   * "run" submits the prompt immediately; "prefill" drops it into the
   * composer for the user to finish (selecting the <placeholder> if there is
   * one); "attach" prefills and opens the file picker.
   */
  action: "run" | "prefill" | "attach";
};

/**
 * Suggestion pool for the new-session hero. Shown HERO_SHORTCUT_COUNT at a
 * time and reshuffled on each visit, so the entry point stays a handful of
 * fresh ideas instead of a wall of ten cards. Pool order matters: the leading
 * window is the curated first-impression mix (an instant run, a prefill, an
 * attach flow, and a health check) that shows when the shuffle is identity
 * (e.g. in tests with Math.random mocked to 0).
 *
 * Every suggestion must succeed inside the default write-jail: reads are
 * broad, but writes land only in the agent workspace. Don't add shortcuts
 * that rename, move, or delete the user's files (tidy a folder, free up
 * disk space, dedupe) — the sandbox denies the write mid-task and June's
 * own suggestion reads as broken.
 */
function agentShortcuts(): AgentShortcut[] {
  return [
    {
      key: "recent-files",
      icon: <IconHistory size={18} />,
      title: t("Catch up on recent files"),
      description: t("A quick rundown of what's new across your folders."),
      prompt: t(
        "Look through my Desktop, Documents, and Downloads folders for files added or changed in the last week and give me a quick rundown of what's new, grouped by what they seem to be for. Don't move or change anything.",
      ),
      action: "run",
    },
    {
      key: "research",
      icon: <IconDeepSearch size={18} />,
      title: t("Research a topic"),
      description: t("Get a short, sourced write-up on anything."),
      prompt: t("Research <topic> and write a short summary of what you find, with sources."),
      action: "prefill",
    },
    {
      key: "summarize-file",
      icon: <IconFileSparkle size={18} />,
      title: t("Summarize a file"),
      description: t("Pick a document and get the key points out of it."),
      prompt: t("Summarize the key points of the attached file and pull out any action items."),
      action: "attach",
    },
    {
      key: "health-check",
      icon: <IconHeartBeat size={18} />,
      title: t("Check my computer's health"),
      description: t("Disk, memory, and login items that need attention."),
      prompt: t(
        "Give my computer a quick health check: free disk space, memory pressure, login items, and anything else worth flagging. Summarize what looks fine and what needs attention.",
      ),
      action: "run",
    },
    {
      key: "find-file",
      icon: <IconMagnifyingGlass size={18} />,
      title: t("Find a file"),
      description: t("Describe what you remember; Sub Rosa tracks it down."),
      prompt: t("Find <a file I half-remember> on my computer and tell me where it is."),
      action: "prefill",
    },
    {
      key: "analyze-spreadsheet",
      icon: <IconPieChart1 size={18} />,
      title: t("Analyze a spreadsheet"),
      description: t("Key figures, trends, and oddities from a CSV or sheet."),
      prompt: t(
        "Analyze the attached spreadsheet: summarize the key figures and trends, and call out anything that looks off.",
      ),
      action: "attach",
    },
    {
      key: "extract-text",
      icon: <IconFileText size={18} />,
      title: t("Extract text from a file"),
      description: t("Pull clean text out of a PDF, image, or scan."),
      prompt: t("Extract all the text from the attached file and clean it up into tidy Markdown."),
      action: "attach",
    },
    {
      key: "plan-project",
      icon: <IconListBullets size={18} />,
      title: t("Plan a project"),
      description: t("Turn a vague goal into concrete first steps."),
      prompt: t(
        "Help me plan <a project>: break it into concrete steps, flag the risks, and suggest what to tackle first.",
      ),
      action: "prefill",
    },
  ];
}

/**
 * Hero greetings, one per visit: the heading cycles through this pool each
 * time the hero is entered, tracked in localStorage so the rotation continues
 * across launches. Exported so tests can match "any greeting".
 */
function heroGreetings() {
  return [
    t("What can Sub Rosa do for you?"),
    t("What should we work on?"),
    t("Where should Sub Rosa start?"),
    t("What can Sub Rosa take off your plate?"),
  ] as const;
}

export const HERO_GREETINGS = heroGreetings();

const HERO_GREETING_INDEX_KEY = "june:agent:hero-greeting";

export function advanceHeroGreeting(): string {
  const greetings = heroGreetings();
  try {
    const index =
      Math.abs(
        Number.parseInt(window.localStorage.getItem(HERO_GREETING_INDEX_KEY) ?? "0", 10) || 0,
      ) % greetings.length;
    window.localStorage.setItem(HERO_GREETING_INDEX_KEY, String((index + 1) % greetings.length));
    return greetings[index];
  } catch {
    // Storage unavailable: any greeting beats none.
    return greetings[Math.floor(Math.random() * greetings.length)];
  }
}

// Three per hand so the row never wraps — a row-count jump mid-rotation would
// shove the footnote around every cycle.
export const HERO_SHORTCUT_COUNT = 3;
// Idle cadence for cycling the hand, and how long the cascade-out runs before
// the deck advances (300ms fade + 2 × 90ms stagger, see .agent-hero-chip).
export const HERO_ROTATE_MS = 8000;
export const HERO_CHIP_SWAP_MS = 500;
const PROVISIONAL_HERMES_SESSION_PREFIX = "pending:new-session:";

export function makeProvisionalHermesSessionId() {
  return `${PROVISIONAL_HERMES_SESSION_PREFIX}${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function isProvisionalHermesSessionId(sessionId?: string | null) {
  return Boolean(sessionId?.startsWith(PROVISIONAL_HERMES_SESSION_PREFIX));
}

// Fisher–Yates with the swap target mirrored (j = i − rand) so a rand() of 0
// is the identity permutation: tests that mock Math.random get the curated
// leading window, real sessions get a fresh shuffle every visit.
export function shuffleAgentShortcuts(): AgentShortcut[] {
  const pool = agentShortcuts();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = i - Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}
