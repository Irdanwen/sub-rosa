/**
 * The research engine in the browser (ADR-0089), one step at a time.
 *
 * A run is one sealed record in the feature's store (IndexedDB): its plan,
 * one step per search, one source per page found. The engine never holds the
 * plan in memory between steps: it reads the record, does the next pending
 * thing, writes that it was done, and reads again. A tab closed between two
 * steps resumes at the next one when `/app` opens again; a step cut in the
 * middle is pending still and is done again, which costs at most one search
 * or one page read twice, never the whole run.
 *
 * Whether a run is being worked on is a question for this tab (`LIVE`),
 * never a stored flag: a record that says "running" in a closed tab is simply
 * picked up by the next tab that ticks.
 */
import {
  assemble,
  clampPlan,
  type Depth,
  type HandedSource,
  isIrrelevant,
  noteUser,
  parsePlan,
  parseQuestions,
  RESEARCH,
  type ResearchPlan,
  reportTitle,
  reportUser,
  requestText,
  withoutTitle,
} from "./core";

export type RunStatus = "clarifying" | "planned" | "running" | "done" | "stopped" | "failed";
export type Phase = "searching" | "reading" | "writing";

export interface Step {
  id: string;
  position: number;
  section: string;
  query: string;
  status: "pending" | "done" | "skipped";
}
export interface Source {
  id: string;
  position: number;
  /** web, note, or connector. */
  kind: string;
  key: string;
  title: string;
  url: string | null;
  noteId: string | null;
  excerpt: string | null;
  /** pending, read, skipped (nothing useful) or failed (unreadable). */
  status: "pending" | "read" | "skipped" | "failed";
  notes: string | null;
}
export interface Run {
  id: string;
  question: string;
  depth: Depth;
  status: RunStatus;
  phase: Phase | null;
  useNotes: boolean;
  /** The research providers (connectors) the person picked for this run. */
  providers: string[];
  chatId: string | null;
  model: string;
  clarifyQuestions: string[];
  clarifyAnswers: string[];
  plan: ResearchPlan | null;
  /** Drawn once, before the report note exists (ADR-0089 addendum). */
  reportNoteId: string | null;
  citedSources: number;
  inventedCitations: number;
  error: string | null;
  steps: Step[];
  sources: Source[];
  createdAt: string;
  updatedAt: string;
}

/** What a run finds: a page, a note or a connector's passage. */
export interface Found {
  kind: string;
  key: string;
  title: string;
  url: string | null;
  noteId: string | null;
  excerpt: string | null;
}

/** Where runs are kept. The feature's sealed store in the page, a map in
 * tests. */
export interface RunStore {
  get(id: string): Promise<Run | undefined>;
  put(run: Run): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<Run[]>;
}

/** What the engine needs from the world, as in `engine.rs`. */
export interface Backend {
  complete(system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<string>;
  /** A thrown error is a failure that ends the step (retried on resume); a
   * search the operator refused answers an empty list. */
  webSearch(query: string, limit: number, signal?: AbortSignal): Promise<Found[]>;
  /** The page's text, or null when it could not be read. */
  fetchPage(url: string, signal?: AbortSignal): Promise<string | null>;
  /** The person's own material: notes, and the connectors picked for the run. */
  ownSources(run: Run, query: string, signal?: AbortSignal): Promise<Found[]>;
  /** Writes the report under `noteId`, creating or rewriting that one note. */
  saveReport(noteId: string, title: string, body: string): Promise<void>;
}

export class ResearchError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();

async function load(store: RunStore, id: string): Promise<Run> {
  const run = await store.get(id);
  if (!run) throw new ResearchError("research_missing", "This research is no longer here.");
  return run;
}
async function save(store: RunStore, run: Run) {
  run.updatedAt = now();
  await store.put(run);
}

/** A source filed once per run, by its key. True when it was new. */
function insertSource(run: Run, found: Found): boolean {
  if (run.sources.some((source) => source.key === found.key)) return false;
  run.sources.push({
    id: crypto.randomUUID(),
    position: run.sources.length + 1,
    kind: found.kind,
    key: found.key,
    title: found.title,
    url: found.url,
    noteId: found.noteId,
    excerpt: found.excerpt,
    status: "pending",
    notes: null,
  });
  return true;
}

const ownKinds = (source: Source) => source.kind !== "web";

/** `engine::advance`: the next pending thing of a running run. True when the
 * run finished. */
export async function advance(
  store: RunStore,
  backend: Backend,
  id: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const run = await load(store, id);
  if (!run.plan)
    throw new ResearchError("research_no_plan", "This research has no approved plan yet.");
  const plan = run.plan;
  const budget = RESEARCH.depths[run.depth];
  const request = requestText(run.question, run.clarifyQuestions, run.clarifyAnswers);

  const step = run.steps.find((item) => item.status === "pending");
  if (step) {
    run.phase = "searching";
    let total = run.sources.length;
    let own = run.sources.filter(ownKinds).length;
    const ownCap = run.useNotes ? budget.ownSources : 0;
    // The web's share, spread over every search of the plan, so the last
    // section still finds sources after the first ones were generous.
    const webCap = budget.maxSources - ownCap;
    const perSearch = Math.min(
      budget.resultsPerQuery,
      Math.max(1, Math.ceil(webCap / Math.max(1, run.steps.length))),
    );
    let added = 0;
    for (const found of await backend.webSearch(step.query, budget.resultsPerQuery, signal)) {
      if (added >= perSearch || total >= budget.maxSources) break;
      if (insertSource(run, found)) {
        added++;
        total++;
      }
    }
    if (own < ownCap && total < budget.maxSources)
      for (const found of await backend.ownSources(run, step.query, signal)) {
        if (own >= ownCap || total >= budget.maxSources) break;
        if (insertSource(run, found)) {
          own++;
          total++;
        }
      }
    signal?.throwIfAborted();
    step.status = "done";
    await save(store, run);
    return false;
  }

  const source = run.sources.find((item) => item.status === "pending");
  if (source) {
    run.phase = "reading";
    if (source.kind === "web" && source.url) {
      const text = await backend.fetchPage(source.url, signal);
      if (text === null) source.status = "failed";
      else {
        const note = await backend.complete(
          RESEARCH.prompts.note,
          noteUser(request, plan, source.title, source.url, text),
          RESEARCH.maxTokens.note,
          signal,
        );
        if (isIrrelevant(note) || !note.trim()) source.status = "skipped";
        else {
          source.status = "read";
          source.notes = note.trim();
        }
      }
    } else {
      // The person's own material arrives as the passages that matched: they
      // are the notes.
      const excerpt = (source.excerpt ?? "").trim();
      source.status = excerpt ? "read" : "skipped";
      source.notes = excerpt;
    }
    signal?.throwIfAborted();
    await save(store, run);
    return false;
  }

  run.phase = "writing";
  const read = run.sources.filter((item) => item.status === "read");
  if (!read.length)
    throw new ResearchError(
      "research_no_sources",
      "No source could be read for this question. Try other searches.",
    );
  // The numbers the model sees are the app's, in the order the sources were
  // read; the report is resolved against exactly this list.
  const handed: HandedSource[] = read.map((item, index) => ({
    index: index + 1,
    kind: item.kind,
    title: item.title,
    url: item.url,
  }));
  const notes = read.map(
    (item, index) => [index + 1, item.title, item.notes ?? ""] as [number, string, string],
  );
  // The note's id is on the record before the note exists: a tab closed
  // after the note was written and before the run was marked done writes the
  // same note again, never a second one.
  if (!run.reportNoteId) {
    run.reportNoteId = crypto.randomUUID();
    await save(store, run);
  }
  const raw = await backend.complete(
    RESEARCH.prompts.report,
    reportUser(request, plan, notes),
    RESEARCH.maxTokens.report,
    signal,
  );
  const assembled = assemble(plan.title, raw, handed);
  signal?.throwIfAborted();
  await backend.saveReport(
    run.reportNoteId,
    reportTitle(assembled.markdown, plan.title),
    withoutTitle(assembled.markdown),
  );
  run.status = "done";
  run.phase = null;
  run.citedSources = assembled.cited.length;
  run.inventedCitations = assembled.invented.length;
  run.error = null;
  await save(store, run);
  return true;
}

// ── Liveness ───────────────────────────────────────────────────────────────

/** The runs this tab is working on, and how to stop each. */
const LIVE = new Map<string, AbortController>();

export function isLive(id: string): boolean {
  return LIVE.has(id);
}

/**
 * `engine::drive`: a run until it is done, stopped, deleted or fails, in this
 * tab. A run another call already drives here is left to it. `changed` is
 * called after every step, for the panel to follow.
 */
export async function drive(
  store: RunStore,
  backend: Backend,
  id: string,
  changed: () => void = () => undefined,
): Promise<void> {
  if (LIVE.has(id)) return;
  const controller = new AbortController();
  LIVE.set(id, controller);
  try {
    for (;;) {
      const run = await store.get(id);
      if (run?.status !== "running") return;
      if (controller.signal.aborted) {
        await markStopped(store, id);
        return;
      }
      try {
        const finished = await advance(store, backend, id, controller.signal);
        changed();
        if (finished) return;
      } catch (error) {
        if (controller.signal.aborted) {
          // The step in flight is dropped; it is still pending and is done
          // again if the run resumes.
          await markStopped(store, id);
          return;
        }
        const current = await store.get(id);
        if (current && current.status === "running") {
          current.status = "failed";
          current.error = error instanceof Error ? error.message : "The research failed.";
          await save(store, current);
        }
        return;
      }
    }
  } finally {
    LIVE.delete(id);
    changed();
  }
}

async function markStopped(store: RunStore, id: string) {
  const run = await store.get(id);
  if (run?.status === "running") {
    run.status = "stopped";
    await save(store, run);
  }
}

// ── The four moves ─────────────────────────────────────────────────────────

/** `research_start`: files the run and asks whether anything needs
 * clarifying. A request that cannot be clarified is planned as asked. */
export async function startRun(
  store: RunStore,
  backend: Backend,
  options: {
    question: string;
    depth: Depth;
    model: string;
    useNotes?: boolean;
    providers?: string[];
    chatId?: string | null;
  },
  signal?: AbortSignal,
): Promise<Run> {
  const question = Array.from(options.question.trim()).slice(0, RESEARCH.maxQuestionChars).join("");
  if (!question) throw new ResearchError("research_empty", "Write what you want researched first.");
  const stamp = now();
  const run: Run = {
    id: crypto.randomUUID(),
    question,
    depth: options.depth,
    status: "clarifying",
    phase: null,
    useNotes: options.useNotes ?? true,
    providers: options.providers ?? [],
    chatId: options.chatId ?? null,
    model: options.model,
    clarifyQuestions: [],
    clarifyAnswers: [],
    plan: null,
    reportNoteId: null,
    citedSources: 0,
    inventedCitations: 0,
    error: null,
    steps: [],
    sources: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  await store.put(run);
  try {
    const reply = await backend.complete(
      RESEARCH.prompts.clarify,
      requestText(question, [], []),
      RESEARCH.maxTokens.clarify,
      signal,
    );
    run.clarifyQuestions = parseQuestions(reply);
  } catch {
    run.clarifyQuestions = [];
  }
  await save(store, run);
  return run;
}

function notStarted(run: Run) {
  if (run.status !== "clarifying" && run.status !== "planned")
    throw new ResearchError("research_already_started", "This research has already started.");
}

/** `research_plan`: the plan from the request and the answers. */
export async function planRun(
  store: RunStore,
  backend: Backend,
  id: string,
  answers: string[],
  signal?: AbortSignal,
): Promise<Run> {
  const run = await load(store, id);
  notStarted(run);
  const clean = answers.map((answer) =>
    Array.from(answer.trim()).slice(0, RESEARCH.maxAnswerChars).join(""),
  );
  const reply = await backend.complete(
    RESEARCH.prompts.plan,
    requestText(run.question, run.clarifyQuestions, clean),
    RESEARCH.maxTokens.plan,
    signal,
  );
  const plan = clampPlan(parsePlan(reply, run.question), run.depth);
  if (!plan) throw new ResearchError("research_plan_empty", "Add at least one search to the plan.");
  run.clarifyAnswers = clean;
  run.plan = plan;
  run.status = "planned";
  run.error = null;
  await save(store, run);
  return run;
}

/** `research_approve`: the plan as the person edited it, one step per
 * search. Driving it is the caller's (`drive`). */
export async function approveRun(
  store: RunStore,
  id: string,
  plan: ResearchPlan,
  depth: Depth,
  providers?: string[],
): Promise<Run> {
  const run = await load(store, id);
  notStarted(run);
  const clamped = clampPlan(plan, depth);
  if (!clamped)
    throw new ResearchError("research_plan_empty", "Add at least one search to the plan.");
  run.plan = clamped;
  run.depth = depth;
  if (providers) run.providers = providers;
  run.steps = clamped.sections.flatMap((section) =>
    section.queries.map((query) => ({
      id: crypto.randomUUID(),
      position: 0,
      section: section.title,
      query,
      status: "pending" as const,
    })),
  );
  run.steps.forEach((step, index) => {
    step.position = index + 1;
  });
  run.sources = [];
  // Approving again is a new run: a new report note.
  run.reportNoteId = null;
  run.status = "running";
  run.phase = "searching";
  run.error = null;
  await save(store, run);
  return run;
}

/** `research_stop`: what was read stays. */
export async function stopRun(store: RunStore, id: string): Promise<void> {
  await markStopped(store, id);
  LIVE.get(id)?.abort();
}

/** `research_resume`: a stopped or failed run, again; `finishNow` writes the
 * report from what was read instead of reading on. */
export async function resumeRun(store: RunStore, id: string, finishNow: boolean): Promise<Run> {
  const run = await load(store, id);
  if (run.status !== "stopped" && run.status !== "failed") return run;
  if (LIVE.has(id))
    throw new ResearchError(
      "research_stopping",
      "This research is still stopping. Try again in a moment.",
    );
  if (finishNow) {
    for (const step of run.steps) if (step.status === "pending") step.status = "skipped";
    for (const source of run.sources) if (source.status === "pending") source.status = "skipped";
  }
  run.status = "running";
  run.error = null;
  await save(store, run);
  return run;
}

/** Forgets a run. Its report, a note, is kept. */
export async function deleteRun(store: RunStore, id: string): Promise<void> {
  LIVE.get(id)?.abort();
  await store.delete(id);
}

/** The runs a tab should pick up: running, and driven by no one here. */
export async function unfinished(store: RunStore): Promise<string[]> {
  return (await store.list())
    .filter((run) => run.status === "running" && !LIVE.has(run.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((run) => run.id);
}

/** A memory store, for tests. */
export function memoryRunStore(): RunStore {
  const runs = new Map<string, Run>();
  return {
    get: async (id) => (runs.has(id) ? structuredClone(runs.get(id)) : undefined),
    put: async (run) => {
      runs.set(run.id, structuredClone(run));
    },
    delete: async (id) => {
      runs.delete(id);
    },
    list: async () => [...runs.values()].map((run) => structuredClone(run)),
  };
}
