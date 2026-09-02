/**
 * The Privacy screen shows what Rust declares, and nothing it wrote itself.
 *
 * The screen's whole value is that it cannot reassure the user about a
 * destination the build would refuse. That only holds while the rows come from
 * `declared_egress`; the moment somebody hard-codes a friendly list here, the
 * page becomes marketing. This asserts the wiring, not the copy.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(async (command: string, _args?: unknown) => {
  if (command === "declared_egress") return declared;
  if (command === "carpe_diem_get_settings") return settings;
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
  convertFileSrc: (path: string) => path,
}));

import { PrivacySettingsSection } from "../components/settings/PrivacySettingsSection";

let declared: Array<{ host: string; reach: string; reason: string }> = [];
let settings: Record<string, unknown> = {};

beforeEach(() => {
  invokeMock.mockClear();
  declared = [
    { host: "127.0.0.1", reach: "always", reason: "The local backend on your own machine." },
    { host: "carpe-diem.xyz", reach: "always", reason: "The default address for your requests." },
    { host: "t.me", reach: "whenAsked", reason: "The community link, when you click it." },
  ];
  settings = { baseUrl: "https://carpe-diem.xyz/api/operator/router", hasApiKey: true };
});

describe("Settings > Privacy", () => {
  it("renders every declared host with the reason Rust gave", async () => {
    render(<PrivacySettingsSection />);
    for (const entry of declared) {
      expect(await screen.findByText(entry.host)).toBeInTheDocument();
      expect(await screen.findByText(entry.reason)).toBeInTheDocument();
    }
  });

  it("separates what runs on its own from what needs the user", async () => {
    render(<PrivacySettingsSection />);
    expect(await screen.findByText("Contacted while the app runs")).toBeInTheDocument();
    expect(await screen.findByText("Contacted only when you ask")).toBeInTheDocument();
  });

  it("says where requests actually go when the base has been changed", async () => {
    settings = { baseUrl: "https://my-own-endpoint.example/v1", hasApiKey: true };
    render(<PrivacySettingsSection />);
    // The declared reason names the default; the screen must not repeat it once
    // the user has pointed the app somewhere else.
    expect(await screen.findByText(/my-own-endpoint\.example/)).toBeInTheDocument();
    expect(screen.queryByText("The default address for your requests.")).toBeNull();
  });

  it("writes no host of its own", async () => {
    declared = [];
    render(<PrivacySettingsSection />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("declared_egress", undefined));
    // With nothing declared, nothing is listed: the page has no list of its own.
    expect(screen.queryByText("carpe-diem.xyz")).toBeNull();
    expect(screen.queryByText("127.0.0.1")).toBeNull();
  });

  it("explains the failure instead of showing an empty page", async () => {
    invokeMock.mockRejectedValueOnce(new Error("nope"));
    render(<PrivacySettingsSection />);
    expect(await screen.findByText(/Could not read the list of destinations/)).toBeInTheDocument();
  });
});
