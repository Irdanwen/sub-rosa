// The public assistant catalog on the website (ADR-0097): search and
// categories over the service's public route, a listing shown as text, the
// "Add to Sub Rosa" link that carries an id and nothing else, and the report
// form. Nothing the service returns is rendered as markup.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importLink, listingIdOf } from "../../website/src/lib/catalog";
import { createSitePaths } from "../../website/src/lib/paths";
import { AssistantCatalog } from "../../website/src/pages/assistants";

const ID = "7f3e2b0c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const SUMMARY = {
  id: ID,
  name: "Plain editor",
  description: "Tightens prose.",
  category: "writing",
  import_count: 3,
  reference_count: 1,
  updated_at: "2026-10-08T10:00:00Z",
  author: { handle: "alice-writes", display_name: "Alice" },
};
const LISTING = {
  ...SUMMARY,
  instructions: "Edit for clarity. <img src=x onerror=alert(1)> <b>bold</b>",
  starter: "Paste a paragraph.",
  permissions: ["web", "notes"],
  references: [{ name: "Style guide", text: "Short sentences." }],
  published_at: "2026-10-08T10:00:00Z",
};

const fetchMock = vi.fn();
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  history.replaceState(null, "", "/assistants");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalog addresses", () => {
  it("reads a listing id only from its own path, and links to the app with it alone", () => {
    expect(listingIdOf(`/assistants/${ID}`)).toBe(ID);
    expect(listingIdOf(`/assistants/${ID.toUpperCase()}`)).toBe(ID);
    for (const bad of ["/assistants", "/assistants/x", `/assistants/${ID}/more`, `/account/${ID}`])
      expect(listingIdOf(bad)).toBeNull();
    expect(importLink(ID)).toBe(`subrosa://assistant/import?id=${ID}`);
    expect(() => importLink("javascript:alert(1)")).toThrow();
  });

  it("lives on the account origin, beside the service it reads", () => {
    const marketing = createSitePaths("/subrosa/", "https://accounts.example");
    expect(marketing.href("/assistants")).toBe("https://accounts.example/assistants");
    expect(marketing.href(`/assistants/${ID}`)).toBe(`https://accounts.example/assistants/${ID}`);
    expect(createSitePaths().href("/assistants")).toBe("/assistants");
  });
});

describe("the catalog page", () => {
  it("searches by text and by category over the public route", async () => {
    fetchMock.mockImplementation(async () => json([SUMMARY]));
    render(<AssistantCatalog path="/assistants" />);
    expect(await screen.findByRole("link", { name: "Plain editor" })).toHaveAttribute(
      "href",
      `/assistants/${ID}`,
    );
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/catalog/assistants");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit" });
    await userEvent.click(screen.getByRole("button", { name: "Research" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/v1/catalog/assistants?category=research"),
    );
    await userEvent.type(screen.getByRole("searchbox"), "editor");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
        "/api/v1/catalog/assistants?q=editor&category=research",
      ),
    );
    expect(location.search).toBe("?q=editor&category=research");
  });

  it("says so when nothing matches", async () => {
    fetchMock.mockImplementation(async () => json([]));
    render(<AssistantCatalog path="/assistants" />);
    expect(await screen.findByText("No assistant matches yet.")).toBeInTheDocument();
  });
});

describe("a listing page", () => {
  it("shows the definition as text, links to the app, and reports", async () => {
    fetchMock.mockImplementation(async (path: string) =>
      path === "/api/v1/reports" ? json({ reported: true }) : json(LISTING),
    );
    const { container } = render(<AssistantCatalog path={`/assistants/${ID}`} />);
    expect(await screen.findByRole("heading", { name: "Plain editor" })).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/catalog/assistants/${ID}`);
    // Text, never markup.
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(container.querySelector("img, b")).toBeNull();
    expect(screen.getByRole("link", { name: "Add to Sub Rosa" })).toHaveAttribute(
      "href",
      `subrosa://assistant/import?id=${ID}`,
    );
    expect(screen.getByText("Read your notes, if you allow it")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Report this assistant"));
    await userEvent.selectOptions(screen.getByRole("combobox"), "abuse");
    await userEvent.click(screen.getByRole("button", { name: "Send the report" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your report was sent.");
    const report = fetchMock.mock.calls.find(([path]) => path === "/api/v1/reports");
    expect(JSON.parse(report?.[1].body)).toEqual({
      target_kind: "assistant",
      target_id: ID,
      reason: "abuse",
      detail: "",
    });
  });

  it("says plainly when a listing is gone", async () => {
    fetchMock.mockImplementation(async () => json({ code: "not_found" }, 404));
    render(<AssistantCatalog path={`/assistants/${ID}`} />);
    expect(await screen.findByText("It was unpublished or taken down.")).toBeInTheDocument();
  });
});
