// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import exported from "@subrosa/chat-core/web/research.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNote } from "../../website/src/client/library";
import {
  assemble,
  ceiling,
  clampPlan,
  type Depth,
  estimate,
  isIrrelevant,
  noteUser,
  parsePlan,
  parseQuestions,
  pricesFrom,
  RESEARCH,
  type ResearchPlan,
  reportTitle,
  reportUser,
  requestText,
  withoutTitle,
} from "../../website/src/client/research/core";
import {
  advance,
  approveRun,
  type Backend,
  drive,
  type Found,
  memoryRunStore,
  planRun,
  resumeRun,
  type RunStore,
  startRun,
  stopRun,
  unfinished,
} from "../../website/src/client/research/engine";
import { liveBackend, researchPrices } from "../../website/src/client/research/live";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { FakeJournal, fakeOperator, text } from "./website-client-fakes";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

const V = (exported as unknown as { vectors: Record<string, Record<string, unknown>> }).vectors;

describe("deep research's pure parts answer what Rust answers", () => {
  it("writes the request, note and report texts byte for byte", () => {
    const request = V.requestText;
    const text = requestText(
      request.question as string,
      request.questions as string[],
      request.answers as string[],
    );
    expect(text).toBe(request.text);
    const note = V.noteUser;
    expect(
      noteUser(
        text,
        note.plan as ResearchPlan,
        ` ${note.title} `,
        note.url as string,
        note.text as string,
      ),
    ).toBe(note.user);
    expect(
      reportUser(text, note.plan as ResearchPlan, V.reportUser.notes as [number, string, string][]),
    ).toBe(V.reportUser.user);
  });

  it("reads questions and plans the way Rust reads them", () => {
    expect(parseQuestions(V.parseQuestions.reply as string)).toEqual(V.parseQuestions.questions);
    const plan = V.parsePlan;
    expect(parsePlan(plan.reply as string, plan.question as string)).toEqual(plan.plan);
    expect(parsePlan("I cannot do that.", plan.question as string)).toEqual(plan.fallback);
    for (const [note, irrelevant] of Object.entries(V.irrelevant))
      expect(isIrrelevant(note)).toBe(irrelevant);
  });

  it("prices the same ceiling for every depth", () => {
    for (const expected of V.estimates as unknown as { depth: Depth }[])
      expect(estimate(expected.depth, 5)).toEqual(expected);
  });

  it("resolves citations, writes the sources list and cuts the model's own", () => {
    const vector = V.assemble;
    const handed = vector.handed as { index: number; kind: string; title: string; url: string }[];
    const assembled = assemble(vector.title as string, vector.raw as string, handed);
    expect(assembled.markdown).toBe(vector.markdown);
    expect(assembled.cited.map((source) => source.index)).toEqual(vector.cited);
    expect(assembled.invented).toEqual(vector.invented);
    expect(reportTitle(assembled.markdown, vector.title as string)).toBe(vector.reportTitle);
    expect(withoutTitle(assembled.markdown)).toBe(vector.withoutTitle);
    const untitled = assemble(vector.title as string, vector.untitledRaw as string, handed);
    expect(untitled.markdown).toBe(vector.untitledMarkdown);
    expect(untitled.invented).toEqual(vector.untitledInvented);
  });

  it("clamps a plan to the depth's searches and refuses an empty one", () => {
    const plan: ResearchPlan = {
      title: " ",
      sections: [
        { title: "", queries: ["a", "  b  c ", "d"] },
        { title: "Two", queries: ["e", "f", "g"] },
      ],
    };
    const quick = clampPlan(plan, "quick");
    expect(quick).toEqual({
      title: "a",
      sections: [
        { title: "a", queries: ["a", "b c", "d"] },
        { title: "Two", queries: ["e"] },
      ],
    });
    expect(RESEARCH.depths.quick.maxQueries).toBe(4);
    expect(
      clampPlan({ title: "x", sections: [{ title: "y", queries: [" "] }] }, "deep"),
    ).toBeNull();
  });

  it("totals the ceiling only when every part has a price", () => {
    const table = {
      models: [{ model: "m", inputPrice: 1, outputPrice: 2 }],
      fixedCost: [
        { model: "augment-search", costUsd: 0.0042 },
        { model: "augment-scrape", costUsd: 0.0051 },
      ],
    };
    const prices = pricesFrom(table, "m");
    const estimated = estimate("quick", 4);
    const full = ceiling(estimated, prices);
    expect(full.modelUsd).toBeCloseTo((49_500 + 15_000 * 2) / 1_000_000);
    expect(full.searchesUsd).toBeCloseTo(4 * 0.0042);
    expect(full.readsUsd).toBeCloseTo(10 * 0.0051);
    expect(full.totalUsd).toBeCloseTo(
      (full.modelUsd ?? 0) + (full.searchesUsd ?? 0) + (full.readsUsd ?? 0),
    );
    const partial = ceiling(estimated, pricesFrom({ ...table, fixedCost: [] }, "m"));
    expect(partial.modelUsd).toBeDefined();
    expect(partial.searchesUsd).toBeUndefined();
    expect(partial.totalUsd).toBeUndefined();
    expect(ceiling(estimated, pricesFrom(table, "other")).totalUsd).toBeUndefined();
  });
});

/** A backend that answers by script and counts what it was asked. */
function scripted(options: { clarify?: string; failSaveOnce?: boolean } = {}) {
  const calls = { searches: [] as string[], reads: [] as string[], reports: 0, notes: 0 };
  const saved: { id: string; title: string; body: string }[] = [];
  const backend: Backend = {
    async complete(system) {
      if (system === RESEARCH.prompts.clarify) return options.clarify ?? '{"questions":[]}';
      if (system === RESEARCH.prompts.plan)
        return JSON.stringify({
          title: "Heat pumps",
          sections: [
            { title: "Cold", queries: ["heat pump cold"] },
            { title: "Cost", queries: ["heat pump cost"] },
          ],
        });
      if (system === RESEARCH.prompts.note) {
        calls.notes++;
        return "- A fact from the page that matters for heat pumps.";
      }
      calls.reports++;
      return "# Heat pumps\n\nThey work [2]. They cost [1][7].\n\n## Sources\n\n- made up";
    },
    async webSearch(query) {
      calls.searches.push(query);
      return [1, 2].map(
        (n): Found => ({
          kind: "web",
          key: `https://example.org/${query.replaceAll(" ", "-")}/${n}`,
          title: `${query} ${n}`,
          url: `https://example.org/${query.replaceAll(" ", "-")}/${n}`,
          noteId: null,
          excerpt: null,
        }),
      );
    },
    async fetchPage(url) {
      calls.reads.push(url);
      return url.endsWith("/2") && url.includes("cost") ? null : `Text of ${url}`;
    },
    async ownSources() {
      return [
        {
          kind: "note",
          key: "note:n1",
          title: "My note",
          url: null,
          noteId: "n1",
          excerpt: "I measured 3.1 in January.",
        },
      ];
    },
    async saveReport(id, title, body) {
      saved.push({ id, title, body });
      if (options.failSaveOnce) {
        options.failSaveOnce = false;
        throw new Error("The tab closed.");
      }
    },
  };
  return { backend, calls, saved };
}

async function approved(store: RunStore, backend: Backend, depth: Depth = "quick") {
  const run = await startRun(store, backend, {
    question: "Do heat pumps work?",
    depth,
    model: "m",
  });
  const planned = await planRun(store, backend, run.id, []);
  return approveRun(store, run.id, planned.plan as ResearchPlan, depth);
}

describe("the research engine", () => {
  it("clarifies, plans, searches, reads and writes one report note", async () => {
    const store = memoryRunStore();
    const { backend, calls, saved } = scripted({ clarify: '{"questions":["Which country?"]}' });
    const started = await startRun(store, backend, {
      question: "Do heat pumps work?",
      depth: "quick",
      model: "m",
    });
    expect(started.status).toBe("clarifying");
    expect(started.clarifyQuestions).toEqual(["Which country?"]);
    const planned = await planRun(store, backend, started.id, ["Switzerland"]);
    expect(planned.status).toBe("planned");
    expect(planned.plan?.sections.map((section) => section.title)).toEqual(["Cold", "Cost"]);
    await approveRun(store, started.id, planned.plan as ResearchPlan, "quick");
    await drive(store, backend, started.id);

    const run = await store.get(started.id);
    expect(run?.status).toBe("done");
    expect(calls.searches).toEqual(["heat pump cold", "heat pump cost"]);
    // Two web sources a search (the quick depth's share), and the note.
    expect(run?.sources.map((source) => source.status)).toEqual([
      "read",
      "read",
      "read",
      "read",
      "failed",
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(run?.reportNoteId);
    expect(saved[0].title).toBe("Heat pumps");
    expect(saved[0].body).toContain("They work [1]. They cost [2].");
    expect(saved[0].body).not.toContain("made up");
    expect(run?.citedSources).toBe(2);
    expect(run?.inventedCitations).toBe(1);
  });

  it("resumes after a reload at the next step, never from the start", async () => {
    const store = memoryRunStore();
    const first = scripted();
    const run = await approved(store, first.backend);
    // Two steps in this "tab": both searches.
    await advance(store, first.backend, run.id);
    await advance(store, first.backend, run.id);
    expect(first.calls.searches).toHaveLength(2);

    // A new tab, a new engine, the same store.
    expect(await unfinished(store)).toEqual([run.id]);
    const second = scripted();
    await drive(store, second.backend, run.id);
    expect(second.calls.searches).toEqual([]);
    expect(second.calls.reads.length).toBeGreaterThan(0);
    expect((await store.get(run.id))?.status).toBe("done");
  });

  it("writes the report into the same note when the tab closed after writing it", async () => {
    const store = memoryRunStore();
    const { backend, saved } = scripted({ failSaveOnce: true });
    const run = await approved(store, backend);
    await drive(store, backend, run.id);
    const failed = await store.get(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.reportNoteId).toBeTruthy();
    await resumeRun(store, run.id, false);
    await drive(store, backend, run.id);
    expect(saved.map((entry) => entry.id)).toEqual([failed?.reportNoteId, failed?.reportNoteId]);
    expect((await store.get(run.id))?.status).toBe("done");
  });

  it("stops between steps, keeps what it read and writes the report from it", async () => {
    const store = memoryRunStore();
    const { backend, calls } = scripted();
    let release: () => void = () => undefined;
    const slow: Backend = {
      ...backend,
      fetchPage: (url, signal) =>
        new Promise((resolve, reject) => {
          release = () => resolve(`Text of ${url}`);
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Stopped", "AbortError")),
          );
        }),
    };
    const run = await approved(store, slow);
    const driving = drive(store, slow, run.id);
    await vi.waitFor(() => expect(calls.searches).toHaveLength(2));
    await stopRun(store, run.id);
    await driving;
    const stopped = await store.get(run.id);
    expect(stopped?.status).toBe("stopped");
    // The page read in flight is still pending, to be done again.
    expect(stopped?.sources.every((source) => source.status === "pending")).toBe(true);
    release();

    await resumeRun(store, run.id, true);
    await drive(store, backend, run.id);
    // Nothing read: the report cannot be written from nothing.
    const after = await store.get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("No source could be read");
  });
});

describe("the research engine's world in the browser", () => {
  it("searches and reads through Carpe Diem, files notes, and prices from /v1/pricing", async () => {
    const sync = new SyncClient(
      "0191d1a4-0000-7000-8000-00000000a11c",
      new Uint8Array(32).fill(3),
      memoryClientStore(),
      new FakeJournal().transport(),
    );
    await createNote(sync, "Heat pump log", "The heat pump ran at 3.1 in January.");
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const { operator, calls } = fakeOperator(() => text("- a note about the page"), {
      "/v1/augment/search": () =>
        json({
          results: [
            { title: "A", url: "https://a.example/x#top", content: "snippet" },
            { title: "Bad", url: "javascript:alert(1)" },
          ],
        }),
      "/v1/augment/scrape": () => json({ content: "The page." }),
      "/v1/pricing": () =>
        json({
          models: [{ model: "m", inputPrice: 1, outputPrice: 2 }],
          fixedCost: [{ model: "augment-search", costUsd: 0.004 }],
        }),
    });
    const backend = liveBackend({ operator, openKey: async () => "cdm_test", sync }, "m");
    const found = await backend.webSearch("heat pump", 5);
    expect(found).toEqual([
      {
        kind: "web",
        key: "https://a.example/x",
        title: "A",
        url: "https://a.example/x#top",
        noteId: null,
        excerpt: "snippet",
      },
    ]);
    expect(await backend.fetchPage("https://a.example/x")).toBe("The page.");
    expect(await backend.complete("system", "user", 10)).toBe("- a note about the page");
    const completion = calls.find((call) => call.path === "/v1/chat/completions");
    expect(completion?.body.max_tokens).toBe(10);
    const own = await backend.ownSources(
      { providers: [] } as unknown as Parameters<Backend["ownSources"]>[0],
      "heat pump",
    );
    expect(own[0]).toMatchObject({ kind: "note", title: "Heat pump log" });

    await backend.saveReport("0192f000-0000-7000-8000-00000000beef", "Report", "Body one");
    await backend.saveReport("0192f000-0000-7000-8000-00000000beef", "Report", "Body two");
    const reports = sync.rows("notes").filter((note) => note.row.title === "Report");
    expect(reports).toHaveLength(1);
    expect(reports[0].row.edited_content).toBe("Body two");

    expect(await researchPrices(operator, "cdm_test", "m")).toEqual({
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 2,
      searchUsd: 0.004,
    });
    expect(await researchPrices(operator, null, "m")).toEqual({});
  });
});
