import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountScope } from "../../website/src/lib/api";
import { setWebsiteLocale } from "../../website/src/lib/i18n";
import {
  SECURITY_HISTORY_ID,
  SecurityHistory,
  securityEventLabel,
} from "../../website/src/pages/security-history";

// The kinds the service records, read from the constraint that admits them so
// a kind added there without a label here fails this suite. Read through
// `import.meta.glob`, the seam the other source-reading tests use.
const MIGRATION = Object.values(
  import.meta.glob("../../subrosa-cloud/migrations/0010_security_events.sql", {
    query: "?raw",
    eager: true,
    import: "default",
  }) as Record<string, string>,
)[0];
const KINDS = (MIGRATION.match(/CHECK\(kind IN \(([^)]*)\)\)/)?.[1] ?? "")
  .split(",")
  .map((kind) => kind.trim().replace(/'/g, ""))
  .filter(Boolean);

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const events = [
  {
    id: "3",
    kind: "device_revoked",
    occurred_at: "2026-10-06T09:30:00Z",
    device_name: "Alice phone",
  },
  { id: "2", kind: "passkey_added", occurred_at: "2026-10-05T18:00:00Z", device_name: null },
  { id: "1", kind: "signed_in", occurred_at: "2026-10-05T17:59:00Z", device_name: null },
];

beforeEach(() => {
  setWebsiteLocale("en");
  setAccountScope("account-a");
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAccountScope(null);
  history.replaceState(null, "", "/");
});

describe("security history", () => {
  it("lists the account's events in the order the service sent them, under the deep link id", async () => {
    const fetch = vi.fn(async () => respond(200, { data: events }));
    vi.stubGlobal("fetch", fetch);
    const view = render(<SecurityHistory />);
    const list = await screen.findByRole("list");
    const lines = within(list).getAllByRole("listitem");
    expect(lines.map((line) => line.querySelector("strong")?.textContent)).toEqual([
      "Device revoked",
      "Passkey added",
      "Signed in on the website",
    ]);
    expect(lines[0]).toHaveTextContent("Alice phone");
    expect(lines[0].querySelector("time")?.getAttribute("dateTime")).toBe(events[0].occurred_at);
    expect(view.container.querySelector(`#${SECURITY_HISTORY_ID}`)).not.toBeNull();
    expect(SECURITY_HISTORY_ID).toBe("security-history");
    expect(screen.getByRole("heading", { name: "Security history" })).toBeInTheDocument();
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/security-events");
    expect(new Headers(init.headers).get("x-subrosa-account-id")).toBe("account-a");
  });

  it("says so when nothing happened in ninety days", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(200, { data: [] })),
    );
    render(<SecurityHistory />);
    expect(await screen.findByText("Nothing recorded in the last 90 days.")).toBeInTheDocument();
  });

  it("shows a failure and loads again on request", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(503, { error: { code: "unavailable", message: "x" } }))
      .mockResolvedValueOnce(respond(200, { data: events.slice(1) }));
    vi.stubGlobal("fetch", fetch);
    render(<SecurityHistory />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not load your security history.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Passkey added")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("drops malformed lines rather than rendering them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respond(200, {
          data: [
            events[1],
            { id: "x", kind: "signed_in", occurred_at: "not a date", device_name: null },
            { id: "y", kind: 4, occurred_at: events[0].occurred_at, device_name: null },
            null,
          ],
        }),
      ),
    );
    render(<SecurityHistory />);
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });

  it("speaks French with the site", async () => {
    setWebsiteLocale("fr");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(200, { data: events })),
    );
    render(<SecurityHistory />);
    expect(await screen.findByText("Appareil révoqué")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Historique de sécurité" })).toBeInTheDocument();
  });

  it("scrolls itself into view when the page was opened at its anchor", async () => {
    history.replaceState(null, "", `/account#${SECURITY_HISTORY_ID}`);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(200, { data: events })),
    );
    render(<SecurityHistory />);
    await screen.findByRole("list");
    expect(scroll).toHaveBeenCalledTimes(1);
    // @ts-expect-error jsdom has no scrollIntoView; remove the stub again.
    delete Element.prototype.scrollIntoView;
  });

  it("names every recorded kind in both languages, in sentence case and without typographic dashes", () => {
    expect(KINDS).toHaveLength(17);
    for (const locale of ["en", "fr"] as const) {
      setWebsiteLocale(locale);
      const fallback = securityEventLabel("something_new");
      const labels = KINDS.map(securityEventLabel);
      expect(new Set(labels).size).toBe(KINDS.length);
      for (const label of labels) {
        expect(label).not.toBe(fallback);
        expect(label).not.toMatch(/[–—]/);
        expect(label[0]).toBe(label[0].toUpperCase());
        expect(label.slice(1)).not.toMatch(/\b[A-Z]{3,}\b/);
      }
    }
    setWebsiteLocale("en");
    expect(securityEventLabel("something_new")).toBe("Account activity");
  });
});
