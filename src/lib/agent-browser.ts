import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

/** The agent browser (ADR-0094), desktop only: status, consent, settings. */

/** Pushed after every change: `AgentBrowserStatus`. */
export const AGENT_BROWSER_STATE_EVENT = "agent-browser://state";
/** A question for the person: `PendingConsent`. */
export const AGENT_BROWSER_CONSENT_EVENT = "agent-browser://consent";

export type AgentBrowserJournalEntry = {
  at: string;
  action: string;
  target: string;
};

export type PendingConsent = {
  id: string;
  /** Null asks whether the browser may be used again after a Stop. */
  site: string | null;
};

export type AgentBrowserStatus = {
  active: boolean;
  stopped: boolean;
  browserName: string | null;
  site: string | null;
  journal: AgentBrowserJournalEntry[];
  pending: PendingConsent[];
};

export type AgentBrowserSettings = {
  enabled: boolean;
  allowedSites: string[];
  browser: string | null;
};

export type InstalledBrowser = { id: string; name: string };

export type AgentBrowserSettingsResponse = {
  settings: AgentBrowserSettings;
  browsers: InstalledBrowser[];
};

export type ConsentAnswer = "always" | "once" | "deny";

export function agentBrowserStatus() {
  return invoke<AgentBrowserStatus>("agent_browser_status");
}

export function agentBrowserSettings() {
  return invoke<AgentBrowserSettingsResponse>("agent_browser_settings");
}

export function saveAgentBrowserSettings(settings: AgentBrowserSettings) {
  return invoke<AgentBrowserSettingsResponse>("agent_browser_save_settings", { settings });
}

export function answerAgentBrowserConsent(id: string, answer: ConsentAnswer) {
  return invoke<void>("agent_browser_answer_consent", { id, answer });
}

export function stopAgentBrowser() {
  return invoke<void>("agent_browser_stop");
}

/** Whether the indicator has anything to show. */
export function indicatorVisible(status: AgentBrowserStatus | null | undefined) {
  return Boolean(status && (status.active || status.pending.length > 0));
}

/** One journal line, in the person's words. Never what was typed: the
 * backend does not keep it. */
export function journalLine(entry: AgentBrowserJournalEntry): string {
  const target = entry.target.trim();
  switch (entry.action) {
    case "open":
      return t("Opened {site}", { site: target });
    case "snapshot":
      return t("Read the page");
    case "click":
      return target ? t("Clicked “{name}”", { name: target }) : t("Clicked");
    case "type":
      return target ? t("Typed into “{name}”", { name: target }) : t("Typed into a field");
    case "select":
      return t("Chose “{name}”", { name: target });
    case "scroll":
      return target === "up" ? t("Scrolled up") : t("Scrolled down");
    case "back":
      return t("Went back");
    case "wait":
      return t("Waited for the page");
    case "read":
      return t("Read the text of the page");
    case "screenshot":
      return t("Looked at the page");
    case "refused":
      return refusalLine(target);
    case "stopped":
      return t("You stopped the browser");
    case "closed":
      return t("Closed the browser");
    default:
      return entry.action;
  }
}

function refusalLine(code: string): string {
  switch (code) {
    case "field_refused":
      return t("Left a password or payment field to you");
    case "captcha_refused":
      return t("Left a CAPTCHA to you");
    case "site_refused":
      return t("Did not open a site you refused");
    default:
      return t("Refused an action");
  }
}

/** The question on a consent card. */
export function consentQuestion(pending: PendingConsent): string {
  return pending.site
    ? t("Let Sub Rosa use {site} in the agent browser?", { site: pending.site })
    : t("You stopped the browser. Let Sub Rosa use it again?");
}
