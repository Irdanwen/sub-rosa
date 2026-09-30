import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../website/src/App";
import { setWebsiteLocale } from "../../website/src/lib/i18n";

beforeEach(() => {
  localStorage.clear();
  setWebsiteLocale("en");
  history.replaceState(null, "", "/account?intent=signup&lang=fr");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "unauthenticated" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

it("keeps the account language choice and signup intent across a reload", async () => {
  const page = render(<App />);
  expect(
    await screen.findByRole("heading", { name: "Votre travail à portée de main." }),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "EN" }));
  expect(screen.getByRole("heading", { name: "Your work, within reach." })).toBeInTheDocument();
  expect(location.pathname + location.search).toBe("/account?intent=signup&lang=en");

  page.unmount();
  render(<App />);
  expect(await screen.findByRole("link", { name: "Create an account" })).toBeInTheDocument();
});
