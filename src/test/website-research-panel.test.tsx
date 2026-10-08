// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FeatureHost, featureStore } from "../../website/src/client/feature";
import { listNotes } from "../../website/src/client/library";
import { researchFeature } from "../../website/src/client/research";
import { RESEARCH } from "../../website/src/client/research/core";
import { ResearchPanel } from "../../website/src/client/research/ResearchPanel";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { FakeJournal, fakeOperator, text } from "./website-client-fakes";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function setup() {
  const store = memoryClientStore();
  const key = new Uint8Array(32).fill(9);
  const sync = new SyncClient(ACCOUNT, key, store, new FakeJournal().transport());
  const { operator, calls } = fakeOperator(
    (body) => {
      const system = (body.messages as { content: string }[])[0].content;
      if (system === RESEARCH.prompts.clarify) return text('{"questions":["Which country?"]}');
      if (system === RESEARCH.prompts.plan)
        return text('{"title":"Heat pumps","sections":[{"title":"Cold","queries":["cop cold"]}]}');
      if (system === RESEARCH.prompts.note) return text("- They keep a COP of 2 at minus 15.");
      return text("# Heat pumps\n\nThey work in the cold [1].");
    },
    {
      "/v1/augment/search": () =>
        json({ results: [{ title: "Study", url: "https://study.example/cop" }] }),
      "/v1/augment/scrape": () => json({ content: "A long field study." }),
      "/v1/pricing": () =>
        json({
          models: [{ model: "m", inputPrice: 1, outputPrice: 2 }],
          fixedCost: [
            { model: "augment-search", costUsd: 0.004 },
            { model: "augment-scrape", costUsd: 0.005 },
          ],
        }),
    },
  );
  const host = {
    account: { id: ACCOUNT, email: "", created_at: "" },
    sync,
    operator,
    openKey: async () => "cdm_test",
    model: "m",
    openChatId: null,
    storeFor: (feature: string) => featureStore(ACCOUNT, key, store, feature),
    openPanel: vi.fn(),
  } as unknown as FeatureHost;
  return { host, sync, calls };
}

describe("the deep research panel", () => {
  it("clarifies, shows the plan with its ceiling, runs and shows the report note", async () => {
    const user = userEvent.setup();
    const { host, sync, calls } = setup();
    render(<ResearchPanel host={host} />);
    await user.type(screen.getByLabelText("What should be researched?"), "Do heat pumps work?");
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Which country?")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Which country?"), "Switzerland");
    await user.click(screen.getByRole("button", { name: "Make the plan" }));
    expect(await screen.findByDisplayValue("Heat pumps")).toBeInTheDocument();
    expect(await screen.findByText(/Total at most/)).toBeInTheDocument();
    // Nothing searched before the plan is approved.
    expect(calls.some((call) => call.path === "/v1/augment/search")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Start research" }));
    expect(
      await screen.findByText(/Saved in your notes/, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    const note = listNotes(sync).find((item) => item.title === "Heat pumps");
    expect(note?.body).toContain("They work in the cold [1].");
    expect(note?.body).toContain("1. [Study](https://study.example/cop)");
  });

  it("hands the composer's draft to the panel", async () => {
    const user = userEvent.setup();
    const { host } = setup();
    const Button = researchFeature.ComposerControl;
    if (!Button) throw new Error("no control");
    const setDraft = vi.fn();
    render(
      <Button
        host={host}
        chatId={null}
        temporary={false}
        draft=" Solar in Zurich "
        setDraft={setDraft}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Deep research" }));
    expect(setDraft).toHaveBeenCalledWith("");
    expect(host.openPanel).toHaveBeenCalledWith("research");
    render(<ResearchPanel host={host} />);
    expect(screen.getByLabelText("What should be researched?")).toHaveValue("Solar in Zurich");
  });
});
