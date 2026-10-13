import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../website/src/App";
import { setWebsiteLocale } from "../../website/src/lib/i18n";

const ACCOUNT = { id: "acc-1", email: "reader@example.org", created_at: "2026-09-01T10:00:00Z" };
const DEVICES = [
  {
    id: "d1",
    name: "Mac",
    created_at: "2026-09-01T10:00:00Z",
    last_seen_at: "2026-10-12T08:00:00Z",
    revoked_at: null,
  },
  {
    id: "d2",
    name: "Phone",
    created_at: "2026-09-02T10:00:00Z",
    last_seen_at: "2026-10-11T08:00:00Z",
    revoked_at: null,
  },
  {
    id: "d3",
    name: "Old laptop",
    created_at: "2026-08-02T10:00:00Z",
    last_seen_at: null,
    revoked_at: "2026-09-02T10:00:00Z",
  },
];

function serve(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "https://accounts.example").pathname;
      const body = routes[path];
      if (body === undefined)
        return new Response(JSON.stringify({ error: { code: "not_found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      return new Response(JSON.stringify({ data: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  setWebsiteLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("the account overview (S5)", () => {
  it("says where the account stands before anything is unlocked", async () => {
    serve({ "/api/v1/me": ACCOUNT, "/api/v1/devices": DEVICES, "/api/v1/security-events": [] });
    history.replaceState(null, "", "/account");
    render(<App />);
    const status = await screen.findByRole("region", { name: "Your account at a glance" });
    expect(status).toHaveTextContent("reader@example.org");
    // Revoked devices are not connected ones.
    expect(await screen.findByText("2 connected")).toBeInTheDocument();
    expect(status).toHaveTextContent("Locked.");
    expect(status).toHaveTextContent("Bought at Carpe Diem.");
    expect(within(status).getByRole("link", { name: "Top up" })).toHaveAttribute(
      "href",
      "/account/top-up",
    );
    // The overview never asks for the vault.
    expect(screen.queryByRole("heading", { name: "Open your vault" })).toBeNull();
  });

  it("says why a page needs the vault, before the form", async () => {
    serve({
      "/api/v1/me": ACCOUNT,
      "/api/v1/vault": { version: 1, envelope: "x" },
    });
    history.replaceState(null, "", "/account/library");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Open your vault" })).toBeInTheDocument();
    expect(
      screen.getByText("Your notes are encrypted. Open the vault to read them here."),
    ).toBeInTheDocument();
  });
});
