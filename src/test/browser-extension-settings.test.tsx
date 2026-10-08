import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserExtensionSection } from "../components/settings/BrowserExtensionSection";
import type { BrowserExtensionStatus } from "../lib/browser-extension";
import { formatPairingCode, pairedBrowserName } from "../lib/browser-extension";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

const browsers: BrowserExtensionStatus["browsers"] = [
  { id: "chrome", label: "Google Chrome", found: true, registered: false },
  { id: "edge", label: "Microsoft Edge", found: false, registered: false },
  { id: "brave", label: "Brave", found: false, registered: false },
  { id: "firefox", label: "Firefox", found: true, registered: false },
];

const idle: BrowserExtensionStatus = { browsers, paired: [], pairing: null, listening: false };

const pairing: BrowserExtensionStatus = {
  browsers: browsers.map((browser) => ({ ...browser, registered: browser.found })),
  paired: [],
  pairing: { code: "482913", expiresAt: new Date(Date.now() + 300_000).toISOString() },
  listening: true,
};

const paired: BrowserExtensionStatus = {
  ...pairing,
  pairing: null,
  paired: [
    {
      id: "p1",
      browser: "edge",
      pairedAt: "2026-10-08T09:00:00Z",
      lastSeenAt: "2026-10-08T10:00:00Z",
    },
  ],
};

describe("Settings › Browser extension", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.listen.mockResolvedValue(() => undefined);
  });

  it("does nothing until asked, then registers and shows a code", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "browser_extension_connect" ? pairing : idle,
    );
    render(<BrowserExtensionSection />);
    expect(await screen.findByText("Found on this computer: Google Chrome, Firefox.")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("browser_extension_status");
    expect(mocks.invoke).not.toHaveBeenCalledWith("browser_extension_connect", expect.anything());

    await userEvent.click(screen.getByRole("button", { name: "Connect a browser" }));
    expect(mocks.invoke).toHaveBeenCalledWith("browser_extension_connect", { browsers: null });
    expect((await screen.findByTestId("pairing-code")).textContent).toBe("482 913");
    expect(screen.getByRole("button", { name: "Show a new code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
  });

  it("lists a paired browser and forgets it on request", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "browser_extension_forget" ? { ...paired, paired: [] } : paired,
    );
    render(<BrowserExtensionSection />);
    expect(await screen.findByText("Microsoft Edge")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.invoke).toHaveBeenCalledWith("browser_extension_forget", { id: "p1" });
    await waitFor(() => expect(screen.queryByText("Microsoft Edge")).toBeNull());
  });

  it("cannot connect when no browser is installed", async () => {
    mocks.invoke.mockResolvedValue({
      ...idle,
      browsers: browsers.map((browser) => ({ ...browser, found: false })),
    });
    render(<BrowserExtensionSection />);
    expect(
      await screen.findByText(
        "No supported browser was found. Open Chrome, Edge, Brave or Firefox once.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Connect a browser" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows the app's reason when registering fails", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "browser_extension_connect") {
        throw new Error("Sub Rosa could not set up your browser to reach it.");
      }
      return idle;
    });
    render(<BrowserExtensionSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect a browser" }));
    expect(
      await screen.findByText("Sub Rosa could not set up your browser to reach it."),
    ).toBeTruthy();
  });

  it("reloads when a browser pairs from the extension", async () => {
    mocks.invoke.mockResolvedValueOnce(pairing).mockResolvedValue(paired);
    let changed: (() => void) | undefined;
    mocks.listen.mockImplementation(async (_event: string, handler: () => void) => {
      changed = handler;
      return () => undefined;
    });
    render(<BrowserExtensionSection />);
    await screen.findByTestId("pairing-code");
    changed?.();
    expect(await screen.findByText("Microsoft Edge")).toBeTruthy();
    expect(screen.queryByTestId("pairing-code")).toBeNull();
  });

  it("formats codes and browser names", () => {
    expect(formatPairingCode("123456")).toBe("123 456");
    expect(formatPairingCode("12")).toBe("12");
    expect(pairedBrowserName("firefox")).toBe("Firefox");
    expect(pairedBrowserName("vivaldi")).toBe("vivaldi");
  });
});
