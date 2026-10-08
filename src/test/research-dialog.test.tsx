// Deep research (ADR-0089): the dialog both shells open walks the run
// through its four moves (ask, clarify, plan with its cost, follow and
// stop) and exports the report the app saved as a note.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as ((event: { payload: { id: string } }) => void)[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: { id: string } }) => void) => {
    mocks.listeners.push(handler);
    return () => undefined;
  }),
}));

import { ResearchDialog } from "../components/research/ResearchDialog";
import { OPEN_NOTE_FROM_CHAT_EVENT } from "../lib/chat-blocks-nav";
import {
  clampPlanSearches,
  planSearches,
  type ResearchPlan,
  type ResearchRun,
} from "../lib/research";

const PLAN: ResearchPlan = {
  title: "Heat pumps in old houses",
  sections: [
    { title: "How well they work", queries: ["heat pump old house efficiency"] },
    { title: "What they cost", queries: ["heat pump cost retrofit", "heat pump subsidies"] },
  ],
};

function run(patch: Partial<ResearchRun>): ResearchRun {
  return {
    id: "r1",
    question: "Are heat pumps worth it in an old house?",
    depth: "standard",
    status: "clarifying",
    phase: null,
    useNotes: true,
    projectId: null,
    chatId: "chat-1",
    clarifyQuestions: [],
    clarifyAnswers: [],
    plan: null,
    model: "flash",
    reportNoteId: null,
    citedSources: 0,
    inventedCitations: 0,
    error: null,
    stepsDone: 0,
    stepsTotal: 0,
    maxSources: 25,
    sourcesFound: 0,
    sourcesRead: 0,
    estimate: null,
    sources: [],
    live: false,
    createdAt: "2026-10-08T09:00:00Z",
    updatedAt: "2026-10-08T09:00:00Z",
    ...patch,
  };
}

const ESTIMATE = {
  searches: 3,
  pageReads: 25,
  modelCalls: 26,
  promptTokens: 1_000_000,
  completionTokens: 100_000,
};

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;
const calls: [string, Record<string, unknown>][] = [];

beforeEach(() => {
  calls.length = 0;
  mocks.listeners.length = 0;
  handlers = {
    research_list: () => [],
    carpe_diem_text_pricing: () => [
      { model: "flash", inputUsdPerMtok: 0.1, outputUsdPerMtok: 0.4 },
    ],
  };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    calls.push([command, args]);
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected ${command}`);
    return handler(args);
  });
});

describe("the plan arithmetic", () => {
  it("counts searches and keeps the first ones a depth allows", () => {
    expect(planSearches(PLAN)).toBe(3);
    const quick = clampPlanSearches(
      { ...PLAN, sections: [...PLAN.sections, { title: "More", queries: ["a", "b"] }] },
      "quick",
    );
    expect(quick.sections.map((section) => section.queries.length)).toEqual([1, 2, 1]);
  });
});

describe("the research dialog", () => {
  it("asks, clarifies, shows the plan and its cost, and starts the run edited", async () => {
    handlers.research_start = () =>
      run({ clarifyQuestions: ["Which country?", "Which kind of house?"] });
    handlers.research_plan = () =>
      run({ status: "planned", plan: PLAN, estimate: ESTIMATE, clarifyAnswers: ["France", ""] });
    handlers.research_approve = (args) =>
      run({
        status: "running",
        phase: "searching",
        plan: (args.request as { plan: ResearchPlan }).plan,
        depth: (args.request as { depth: "quick" }).depth,
        maxSources: 10,
      });
    render(
      <ResearchDialog
        open
        onClose={() => undefined}
        initialQuestion="Are heat pumps worth it in an old house?"
        chatId="chat-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Deep/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "research_start",
        {
          request: {
            question: "Are heat pumps worth it in an old house?",
            depth: "deep",
            useNotes: true,
            chatId: "chat-1",
          },
        },
      ]),
    );

    fireEvent.change(await screen.findByLabelText("Which country?"), {
      target: { value: "France" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "research_plan",
        { request: { id: "r1", answers: ["France", ""] } },
      ]),
    );

    // The plan, editable, with what it will cost at most.
    expect(await screen.findByDisplayValue("Heat pumps in old houses")).toBeTruthy();
    expect(
      screen.getByText("Up to 25 sources: 3 searches, 25 page reads and 26 model calls."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByText(
          "At most about $0.14 in model tokens. Searches and page reads are billed apart.",
        ),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Remove this section" })[0]);
    fireEvent.change(screen.getByLabelText("Searches, one per line"), {
      target: { value: "heat pump cost retrofit\n\nheat pump grants France" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Quick/ }));
    expect(
      screen.getByText("Up to 10 sources: 2 searches, 10 page reads and 11 model calls."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start research" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "research_approve",
        {
          request: {
            id: "r1",
            depth: "quick",
            plan: {
              title: "Heat pumps in old houses",
              sections: [
                {
                  title: "What they cost",
                  queries: ["heat pump cost retrofit", "heat pump grants France"],
                },
              ],
            },
          },
        },
      ]),
    );
    expect(await screen.findByText("Searching · Read 0 sources")).toBeTruthy();
  });

  it("goes straight to the plan when there is nothing to clarify", async () => {
    handlers.research_start = () => run({});
    handlers.research_plan = () => run({ status: "planned", plan: PLAN, estimate: ESTIMATE });
    render(<ResearchDialog open onClose={() => undefined} initialQuestion="Heat pumps" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByDisplayValue("Heat pumps in old houses")).toBeTruthy();
    expect(calls).toContainEqual(["research_plan", { request: { id: "r1", answers: [] } }]);
  });

  it("follows a run, stops it, writes the report from what was read, and exports it", async () => {
    let current = run({
      status: "running",
      phase: "reading",
      plan: PLAN,
      sourcesRead: 4,
      sourcesFound: 6,
      sources: [
        {
          position: 1,
          kind: "web",
          title: "Field study",
          url: "https://www.a.example/x",
          status: "read",
        },
        { position: 2, kind: "web", title: "Blocked", url: "https://b.example", status: "failed" },
        {
          position: 3,
          kind: "note",
          title: "Call with the installer",
          noteId: "n1",
          status: "read",
        },
      ],
    });
    handlers.research_list = () => [current];
    handlers.research_get = () => current;
    handlers.research_stop = () => {
      current = { ...current, status: "stopped" };
      return current;
    };
    handlers.research_resume = (args) => {
      expect(args).toEqual({ request: { id: "r1", finishNow: true } });
      current = { ...current, status: "running", phase: "writing" };
      return current;
    };
    handlers.note_export_document = () => ({
      path: "/Users/me/Report.docx",
      bytes: 10,
      shared: false,
    });
    const opened: string[] = [];
    window.addEventListener(OPEN_NOTE_FROM_CHAT_EVENT, (event) =>
      opened.push((event as CustomEvent<{ noteId: string }>).detail.noteId),
    );
    const onClose = vi.fn();
    render(<ResearchDialog open onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: /Heat pumps in old houses/ }));
    expect(await screen.findByText("Reading sources · Read 4 sources")).toBeTruthy();
    const sources = screen.getByRole("list", { name: "Sources" });
    expect(within(sources).getByText("a.example")).toBeTruthy();
    expect(within(sources).getByText("Unreadable")).toBeTruthy();
    expect(within(sources).getByText("Your note")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(await screen.findByRole("button", { name: "Write the report now" }));
    expect(await screen.findByText("Writing the report · Read 4 sources")).toBeTruthy();

    // The engine finishes; the event names the run and the dialog reads it.
    current = {
      ...current,
      status: "done",
      phase: null,
      reportNoteId: "note-report",
      citedSources: 3,
      inventedCitations: 1,
    };
    await act(async () => {
      for (const listener of mocks.listeners) listener({ payload: { id: "r1" } });
    });
    expect(
      await screen.findByText(/The report is in your notes\. It cites 3 sources\./),
    ).toBeTruthy();
    expect(screen.getByText("1 citation named no source and was removed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Word" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "note_export_document",
        { request: { noteId: "note-report", format: "docx" } },
      ]),
    );
    expect(await screen.findByText("Saved to /Users/me/Report.docx")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the report" }));
    expect(opened).toEqual(["note-report"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a failure in words and retries it", async () => {
    const failed = run({
      status: "failed",
      plan: PLAN,
      error: "No source could be read for this question. Try other searches.",
    });
    handlers.research_list = () => [failed];
    handlers.research_get = () => failed;
    handlers.research_resume = () => ({ ...failed, status: "running", phase: "searching" });
    render(<ResearchDialog open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /Did not finish/ }));
    expect(
      await screen.findByText("No source could be read for this question. Try other searches."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "research_resume",
        { request: { id: "r1", finishNow: false } },
      ]),
    );
  });
});
