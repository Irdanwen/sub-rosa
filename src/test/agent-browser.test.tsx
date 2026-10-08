/**
 * The agent browser's presence in the app (ADR-0094): the consent card
 * answers with the person's choice, Stop reaches the backend, and the journal
 * says what happened without ever holding what was typed.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

let status: unknown = null;
let settings: unknown = null;
const invokeMock = vi.fn(async (command: string, args?: unknown) => {
  if (command === "agent_browser_status") return status;
  if (command === "agent_browser_settings") return settings;
  if (command === "agent_browser_save_settings") {
    const next = (args as { settings: { allowedSites: string[] } }).settings;
    return { settings: next, browsers: [{ id: "chrome", name: "Google Chrome" }] };
  }
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

import { AgentBrowserIndicator } from "../components/agent-browser/AgentBrowserIndicator";
import { AgentBrowserSettingsSection } from "../components/settings/AgentBrowserSettingsSection";
import agentBrowserCss from "../styles/agent-browser.css?raw";
import appCss from "../styles/app.css?raw";
import {
  type AgentBrowserStatus,
  consentQuestion,
  indicatorVisible,
  journalLine,
} from "../lib/agent-browser";

const idle: AgentBrowserStatus = {
  active: false,
  stopped: false,
  browserName: null,
  site: null,
  journal: [],
  pending: [],
};

beforeEach(() => {
  invokeMock.mockClear();
  listeners.clear();
  status = idle;
  settings = null;
});

describe("journal lines", () => {
  it("say what the agent did, in the person's words", () => {
    const at = "2026-10-08T10:00:00Z";
    expect(journalLine({ at, action: "open", target: "example.com" })).toBe("Opened example.com");
    expect(journalLine({ at, action: "click", target: "Search" })).toBe("Clicked “Search”");
    expect(journalLine({ at, action: "type", target: "Destination" })).toBe(
      "Typed into “Destination”",
    );
    expect(journalLine({ at, action: "scroll", target: "up" })).toBe("Scrolled up");
    expect(journalLine({ at, action: "refused", target: "field_refused" })).toBe(
      "Left a password or payment field to you",
    );
    expect(journalLine({ at, action: "refused", target: "captcha_refused" })).toBe(
      "Left a CAPTCHA to you",
    );
  });

  it("ask about a site, or about coming back after a Stop", () => {
    expect(consentQuestion({ id: "1", site: "example.com" })).toBe(
      "Let Sub Rosa use example.com in the agent browser?",
    );
    expect(consentQuestion({ id: "2", site: null })).toContain("You stopped the browser");
    expect(indicatorVisible(idle)).toBe(false);
    expect(indicatorVisible({ ...idle, pending: [{ id: "1", site: "a.com" }] })).toBe(true);
  });
});

describe("AgentBrowserIndicator", () => {
  it("shows nothing while the browser is idle", async () => {
    const { container } = render(<AgentBrowserIndicator />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("agent_browser_status", undefined));
    expect(container).toBeEmptyDOMElement();
  });

  it("answers a consent card with the person's choice", async () => {
    status = { ...idle, pending: [{ id: "c1", site: "example.com" }] };
    render(<AgentBrowserIndicator />);
    fireEvent.click(await screen.findByRole("button", { name: "Always allow" }));
    expect(invokeMock).toHaveBeenCalledWith("agent_browser_answer_consent", {
      id: "c1",
      answer: "always",
    });
  });

  it("follows pushed state, and Stop reaches the backend", async () => {
    render(<AgentBrowserIndicator />);
    await waitFor(() => expect(listeners.has("agent-browser://state")).toBe(true));
    act(() => {
      listeners.get("agent-browser://state")?.({
        payload: {
          ...idle,
          active: true,
          site: "example.com",
          journal: [{ at: "t", action: "open", target: "example.com" }],
        },
      });
    });
    expect(
      await screen.findByText("Sub Rosa is using the browser on example.com"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Steps" }));
    expect(screen.getByText("Opened example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(invokeMock).toHaveBeenCalledWith("agent_browser_stop", undefined);
  });

  it("numbers the newest step last, so the top line is not step 1", async () => {
    render(<AgentBrowserIndicator />);
    await waitFor(() => expect(listeners.has("agent-browser://state")).toBe(true));
    act(() => {
      listeners.get("agent-browser://state")?.({
        payload: {
          ...idle,
          active: true,
          journal: [
            { at: "1", action: "open", target: "example.com" },
            { at: "2", action: "snapshot", target: "" },
          ],
        },
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Steps" }));
    const list = screen.getByRole("list");
    expect(list).toHaveAttribute("reversed");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Read the page", "Opened example.com"]);
  });
});

describe("the styles these surfaces rely on", () => {
  // A real render showed both: a primary answer as faint as its neighbours,
  // and the site name cut off the end of the bar.
  it("fills a primary button everywhere, and lets the bar's sentence wrap", () => {
    expect(appCss).toMatch(
      /\n\.btn-primary \{\s*background: var\(--primary\);\s*color: var\(--primary-foreground\);/,
    );
    const bar = /\.agent-browser-bar-label \{([^}]*)\}/.exec(agentBrowserCss)?.[1];
    expect(bar).toBeDefined();
    expect(bar).not.toContain("nowrap");
    expect(bar).not.toContain("ellipsis");
  });
});

describe("Settings › Agent browser", () => {
  it("removes an allowed site", async () => {
    settings = {
      settings: { enabled: true, allowedSites: ["example.com", "wikipedia.org"], browser: null },
      browsers: [{ id: "chrome", name: "Google Chrome" }],
    };
    render(<AgentBrowserSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove example.com" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("agent_browser_save_settings", {
        settings: { enabled: true, allowedSites: ["wikipedia.org"], browser: null },
      }),
    );
    expect(await screen.findByText("wikipedia.org")).toBeInTheDocument();
  });

  it("says when no browser is installed", async () => {
    settings = { settings: { enabled: true, allowedSites: [], browser: null }, browsers: [] };
    render(<AgentBrowserSettingsSection />);
    expect(
      await screen.findByText("No Chrome, Edge, Brave or Chromium was found on this computer."),
    ).toBeInTheDocument();
  });
});
