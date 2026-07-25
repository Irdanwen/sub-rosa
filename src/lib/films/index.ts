// Film production (ADR-0010, fork, desktop only): typed views over the raw
// Videomaker payloads returned by the videomaker* bindings in src/lib/tauri.ts,
// plus the live-event subscription re-emitted by the Rust SSE watcher.

export const FILM_EVENT = "june://videomaker-event";

/// Videomaker's SSE kinds (scene, ledger, phase_gate, run, ...) plus the
/// watcher's synthetic kinds.
export type FilmEvent = {
  slug: string;
  kind: string;
  data: unknown;
};

export type FilmProject = {
  slug: string;
  displaySlug?: string;
  title: string;
  state: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  finalMp4: boolean;
};

/// The curated model sets a film can be produced with. Sub Rosa never picks
/// individual models (the studio owns that); it picks which locked set the
/// film uses, and the studio freezes that choice at creation.
export const FILM_MODEL_SETS = ["full_quality", "uncensored"] as const;
export type FilmModelSet = (typeof FILM_MODEL_SETS)[number];

export const FILM_MODEL_SET_LABELS: Record<FilmModelSet, string> = {
  full_quality: "Default",
  uncensored: "Uncensored",
};

/// The studio's holistic film judge (it scores the delivered master as a film,
/// never blocks delivery) plus the shots it would rework first. Absent until a
/// judged final cut exists.
export type FilmReview = {
  narrativeClarity?: number;
  pacing?: number;
  visualIdentity?: number;
  emotionalPayoff?: number;
  /** LOWER is better: how strongly the film reads as AI-generated. */
  aiTellScore?: number;
  weakestShots: string[];
  notes?: string;
};

export type FilmStatus = {
  daemon: string;
  queue: { queued: number; running: number; blockedQuota: number; done: number; failed: number };
  cost: {
    spentDiem: number;
    pendingDiem: number;
    projectedDiem: number;
    ceilingDiem?: number;
  };
  walletEmpty: boolean;
  /** True when phase gates self-approve (hands-off) rather than await the user's sign-off. */
  autonomous: boolean;
  /** Shots the studio placeholder-skipped to keep the film moving. */
  shotsToReview: string[];
  review?: FilmReview;
};

/// What the studio's run driver left behind when it stopped. `detail` is a raw
/// string while a run walks the phases ("phase: storyboard", the paused gate)
/// and a JSON blob on the money-bearing stops, so both are parsed here once.
export type FilmRunOutcome = {
  /** Set by the studio when the run envelope, not the production quote, ran out. */
  reason?: string;
  projectedCostDiem?: number;
  maxCostDiem?: number;
  budgetDiem?: number;
  spentDiem?: number;
  openTasks?: number;
  /** The studio's own sentence, when it gave one. */
  message?: string;
  /** Free-form detail (phase name, gate name, stall reason). */
  text?: string;
};

export type FilmRun = {
  id: string;
  status: string;
  detail?: string;
  outcome: FilmRunOutcome;
  createdAt?: string;
};

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function parseProject(raw: unknown): FilmProject | null {
  const project = record(raw);
  const slug = str(project.slug);
  if (!slug) return null;
  return {
    slug,
    displaySlug: str(project.display_slug),
    title: str(project.title) ?? slug,
    state: str(project.state) ?? "new",
    createdAt: str(project.created_at),
    updatedAt: str(project.updated_at),
    expiresAt: str(project.expires_at),
    finalMp4: project.final_mp4 === true,
  };
}

export function parseProjectList(raw: unknown): FilmProject[] {
  const list = record(raw).projects;
  if (!Array.isArray(list)) return [];
  return list.map(parseProject).filter((project): project is FilmProject => project !== null);
}

export function parseStatus(raw: unknown): FilmStatus {
  const status = record(raw);
  const queue = record(status.queue);
  const cost = record(status.cost);
  return {
    daemon: str(status.daemon) ?? "idle",
    queue: {
      queued: num(queue.queued),
      running: num(queue.running),
      blockedQuota: num(queue.blocked_quota),
      done: num(queue.done),
      failed: num(queue.failed),
    },
    cost: {
      spentDiem: num(cost.spent_diem),
      pendingDiem: num(cost.pending_diem),
      projectedDiem: num(cost.projected_diem),
      ceilingDiem: typeof cost.ceiling_diem === "number" ? cost.ceiling_diem : undefined,
    },
    walletEmpty: status.wallet_empty === true,
    autonomous: status.autonomous === true,
    shotsToReview: parseShotIds(status.shots_to_review),
    review: parseReview(status.film_qa),
  };
}

function score(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/// `shots_to_review` is a list of ledger rows (`{shot_id, ...}`); older or
/// leaner payloads send bare ids.
function parseShotIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === "string") return entry ? [entry] : [];
    const id = str(record(entry).shot_id);
    return id ? [id] : [];
  });
}

function parseReview(raw: unknown): FilmReview | undefined {
  const verdict = record(raw);
  // The judge writes `ok: false, skipped: true` on a vision outage rather than
  // faking scores: that is not a review, so surface nothing.
  if (verdict.ok !== true) return undefined;
  const weakestShots = Array.isArray(verdict.weakest_shots)
    ? verdict.weakest_shots.filter((shot): shot is string => typeof shot === "string" && !!shot)
    : [];
  const review: FilmReview = {
    narrativeClarity: score(verdict.narrative_clarity),
    pacing: score(verdict.pacing),
    visualIdentity: score(verdict.visual_identity),
    emotionalPayoff: score(verdict.emotional_payoff),
    aiTellScore: score(verdict.ai_tell_score),
    weakestShots,
    notes: str(verdict.notes),
  };
  const scored = [
    review.narrativeClarity,
    review.pacing,
    review.visualIdentity,
    review.emotionalPayoff,
    review.aiTellScore,
  ].some((value) => value !== undefined);
  return scored || weakestShots.length > 0 || review.notes ? review : undefined;
}

function parseRunOutcome(detail: string | undefined): FilmRunOutcome {
  if (!detail) return {};
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed === "object" && parsed !== null) payload = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the driver's plain progress/pause note.
  }
  if (!payload) return { text: detail };
  return {
    reason: str(payload.reason),
    projectedCostDiem:
      typeof payload.projected_cost_diem === "number" ? payload.projected_cost_diem : undefined,
    maxCostDiem: typeof payload.max_cost_diem === "number" ? payload.max_cost_diem : undefined,
    budgetDiem: typeof payload.budget_diem === "number" ? payload.budget_diem : undefined,
    spentDiem: typeof payload.spent_diem === "number" ? payload.spent_diem : undefined,
    openTasks: typeof payload.open_tasks === "number" ? payload.open_tasks : undefined,
    message: str(payload.message),
  };
}

export function parseRun(raw: unknown): FilmRun | null {
  const run = record(record(raw).run ?? raw);
  const id = str(run.id);
  if (!id) return null;
  const detail = str(run.detail);
  return {
    id,
    status: str(run.status) ?? "running",
    detail,
    outcome: parseRunOutcome(detail),
    createdAt: str(run.created_at),
  };
}

/// `GET /runs` — newest first (the studio orders by creation), so the head is
/// the run that owns the project right now.
export function parseRuns(raw: unknown): FilmRun[] {
  const list = record(raw).runs;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const run = parseRun(entry);
    return run ? [run] : [];
  });
}

/// Run statuses that mean "the studio stopped and is waiting for you" — the
/// project looks idle but only a decision (or a resume) moves it again.
const STALLED_RUN_STATUSES = new Set([
  "paused_gate",
  "awaiting_confirmation",
  "failed",
  "interrupted",
  "cancelled",
]);

export function isRunStalled(run: FilmRun | null | undefined): boolean {
  return run !== null && run !== undefined && STALLED_RUN_STATUSES.has(run.status);
}

/// One sentence per run status, in the app's voice. The studio's own detail is
/// written in French for its web studio, so only its numbers are reused.
export function filmRunSummary(run: FilmRun): { headline: string; hint?: string } {
  const { outcome } = run;
  switch (run.status) {
    case "running": {
      const phase = outcome.text?.replace(/^phase:\s*/i, "");
      return {
        headline: "The crew is working",
        hint: phase ? `Phase: ${phase.replaceAll("_", " ")}` : undefined,
      };
    }
    case "paused_gate": {
      const phase = outcome.text?.split(":").pop()?.trim();
      return {
        headline: "Paused for your approval",
        hint: phase
          ? `Approve the ${phase.replaceAll("_", " ")} phase below to carry on.`
          : undefined,
      };
    }
    case "awaiting_confirmation":
      if (outcome.reason === "run_budget_exhausted") {
        return {
          headline: "Run budget spent",
          hint: `The run used its ${formatRunDiem(outcome.budgetDiem)} envelope${
            outcome.spentDiem ? ` (${formatRunDiem(outcome.spentDiem)} spent)` : ""
          }. Resume it to give the crew a fresh envelope.`,
        };
      }
      return {
        headline: "Waiting for your go-ahead on the cost",
        hint: outcome.projectedCostDiem
          ? `Production is quoted at ${formatRunDiem(outcome.projectedCostDiem)}, above the ${formatRunDiem(outcome.maxCostDiem)} cap you set.`
          : outcome.message,
      };
    case "production_started":
      return {
        headline: "Rendering the shots",
        hint: "The film downloads to the gallery when it is cut.",
      };
    case "completed":
      return { headline: "Creative phases done", hint: outcome.text ?? outcome.message };
    case "failed":
      return { headline: "The run stopped early", hint: outcome.text ?? outcome.message };
    case "interrupted":
      return {
        headline: "The run was interrupted",
        hint: "Resume it: the studio picks up at the last saved phase.",
      };
    case "cancelled":
      return { headline: "Run stopped", hint: "Resume it whenever you want to continue." };
    default:
      return { headline: run.status.replaceAll("_", " "), hint: outcome.text ?? outcome.message };
  }
}

function formatRunDiem(value: number | undefined): string {
  if (typeof value !== "number") return "the agreed budget";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} DIEM`;
}

/// The produce handshake payload (flattened by the Rust command: a 409 quote
/// comes back as a success payload with needs_confirmation). The nested form
/// is read too, so a payload that reaches the UI still wrapped in the studio's
/// `detail` envelope is understood instead of silently dropped.
export function parseProduceOutcome(raw: unknown): {
  started: boolean;
  needsConfirmation: boolean;
  projectedCostDiem?: number;
} {
  const outer = record(raw);
  const body = record(outer.detail ?? outer);
  const projected = body.projected_cost_diem ?? outer.projected_cost_diem;
  return {
    started: outer.started === true || body.started === true,
    needsConfirmation: body.needs_confirmation === true || outer.needs_confirmation === true,
    projectedCostDiem: typeof projected === "number" ? projected : undefined,
  };
}

// --- director mode (gated projects) ------------------------------------------

export const FILM_CHAT_EVENT = "june://videomaker-chat";

export type FilmGate = {
  phase: string;
  status?: string;
  open: boolean;
  decisionReason?: string;
  updatedAt?: string;
};

export type FilmChatMessage = {
  role: "user" | "assistant";
  content: string;
};

/// The studio runs a crew: the desk agent delegates each department's work to a
/// specialist, and a chat turn streams one `agent` event per delegation
/// (alongside the `tool` events). These are the departments a user can see
/// working; anything else falls back to its raw id.
const FILM_CREW_LABELS: Record<string, string> = {
  front_desk: "Studio desk",
  showrunner: "Showrunner",
  scenarist: "Screenwriter",
  composition_director: "Composition director",
  image_prompter: "Image prompter",
  video_prompter: "Video prompter",
  asset_builder: "Art department",
  continuity: "Script supervisor",
  production_manager: "Production manager",
  editor: "Editor",
  critic_story: "Story critic",
  critic_vision: "Vision critic",
  critic_film: "Film critic",
  visual_qa: "Visual QA",
};

export function filmCrewLabel(roleId: string): string {
  const adhoc = roleId.startsWith("adhoc:") ? roleId.slice("adhoc:".length) : null;
  if (adhoc) return adhoc.replaceAll("_", " ");
  return FILM_CREW_LABELS[roleId] ?? roleId.replaceAll("_", " ");
}

/// One delegation boundary of a streamed chat turn (`{type:"agent"}`), or null
/// for any other event shape.
export type FilmCrewEvent = {
  role: string;
  label: string;
  /** The studio's task id, so a start and its end pair up. */
  taskId?: number;
  goal?: string;
  done: boolean;
  failed: boolean;
  costDiem?: number;
};

export function parseCrewEvent(raw: unknown): FilmCrewEvent | null {
  const event = record(raw);
  if (event.type !== "agent") return null;
  const role = str(event.role);
  if (!role) return null;
  return {
    role,
    label: filmCrewLabel(role),
    taskId: typeof event.task_id === "number" ? event.task_id : undefined,
    goal: str(event.goal),
    done: event.phase !== "start",
    failed: event.status === "failed",
    costDiem: typeof event.cost_diem === "number" ? event.cost_diem : undefined,
  };
}

export type FilmBoardShot = {
  shotId: string;
  status: string;
  durationSec?: number;
  prompt?: string;
  frameUrl?: string;
  clipUrl?: string;
  takes: number;
  error?: string;
  toReview: boolean;
};

export type FilmBoardScene = {
  sceneId: string;
  title: string;
  state?: string;
  previewUrl?: string;
  shots: FilmBoardShot[];
};

export type FilmBoard = {
  scenes: FilmBoardScene[];
  totals: {
    shotsDone: number;
    shotsTotal: number;
    spentDiem: number;
    budgetCeilingDiem?: number;
    etaSeconds?: number;
  };
  finalUrl?: string;
};

export type FilmTake = {
  version: number;
  url?: string;
  isCurrent: boolean;
  durationSec?: number;
};

export function parseGates(raw: unknown): FilmGate[] {
  const list = record(raw).gates;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const gate = record(entry);
    const phase = str(gate.phase);
    if (!phase) return [];
    return [
      {
        phase,
        status: str(gate.status),
        open: gate.open === true,
        decisionReason: str(gate.decision_reason),
        updatedAt: str(gate.updated_at),
      },
    ];
  });
}

export function parseTranscript(raw: unknown): FilmChatMessage[] {
  const list = record(raw).messages;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const message = record(entry);
    const role = message.role;
    const content = str(message.content);
    if ((role !== "user" && role !== "assistant") || !content) return [];
    return [{ role, content }];
  });
}

export function parseBoard(raw: unknown): FilmBoard {
  const board = record(raw);
  const totals = record(board.totals);
  const scenes = Array.isArray(board.scenes) ? board.scenes : [];
  return {
    scenes: scenes.flatMap((entry) => {
      const scene = record(entry);
      const sceneId = str(scene.scene_id);
      if (!sceneId) return [];
      const shots = Array.isArray(scene.shots) ? scene.shots : [];
      return [
        {
          sceneId,
          title: str(scene.title) ?? sceneId,
          state: str(scene.state),
          previewUrl: str(scene.preview_url),
          shots: shots.flatMap((shotEntry) => {
            const shot = record(shotEntry);
            const shotId = str(shot.shot_id);
            if (!shotId) return [];
            return [
              {
                shotId,
                status: str(shot.status) ?? "planned",
                durationSec: typeof shot.duration_sec === "number" ? shot.duration_sec : undefined,
                prompt: str(shot.prompt),
                frameUrl: str(shot.frame_url),
                clipUrl: str(shot.clip_url),
                takes: num(shot.takes),
                error: str(shot.error),
                toReview: shot.to_review === true,
              },
            ];
          }),
        },
      ];
    }),
    totals: {
      shotsDone: num(totals.shots_done),
      shotsTotal: num(totals.shots_total),
      spentDiem: num(totals.spent_diem),
      budgetCeilingDiem:
        typeof totals.budget_ceiling_diem === "number" ? totals.budget_ceiling_diem : undefined,
      etaSeconds: typeof totals.eta_seconds === "number" ? totals.eta_seconds : undefined,
    },
    finalUrl: str(board.final_url),
  };
}

export function parseTakes(raw: unknown): FilmTake[] {
  const list = record(raw).takes;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const take = record(entry);
    const version = take.version;
    if (typeof version !== "number") return [];
    return [
      {
        version,
        url: str(take.url),
        isCurrent: take.is_current === true,
        durationSec: typeof take.duration_sec === "number" ? take.duration_sec : undefined,
      },
    ];
  });
}

// --- reference images ----------------------------------------------------------

export const FILM_REF_ROLES = ["character", "location", "style", "object"] as const;
export type FilmRefRole = (typeof FILM_REF_ROLES)[number];

export const FILM_REF_ROLE_LABELS: Record<FilmRefRole, string> = {
  character: "Character",
  location: "Location",
  style: "Style",
  object: "Object",
};

/// A reference image picked in the form, before upload. `base64Data` is the
/// original file (sent to the studio); `previewDataUri` is a downscaled copy
/// (thumbnail + what the brief improver analyzes).
export type FilmBriefRef = {
  /** Client-side identity (list key), never sent anywhere. */
  id: string;
  role: FilmRefRole;
  label: string;
  fileName: string;
  base64Data: string;
  previewDataUri: string;
};

export type UploadedFilmRef = {
  publicUrl: string;
  relativePath: string;
};

export function parseUploadedRef(raw: unknown): UploadedFilmRef | null {
  const payload = record(raw);
  const publicUrl = str(payload.public_url);
  const relativePath = str(payload.relative_path);
  if (!publicUrl || !relativePath) return null;
  return { publicUrl, relativePath };
}

function refLabelSuffix(label: string): string {
  return label.trim() ? ` "${label.trim()}"` : "";
}

/// One standalone reference line (director-chat attachments).
export function filmRefLine(ref: { role: FilmRefRole; label: string; url: string }): string {
  return `Reference image (${ref.role}${refLabelSuffix(ref.label)}): ${ref.url}`;
}

/// The block appended to an autonomous brief (or seeded into the director
/// chat) once the picked references are uploaded. Numbering matches the order
/// the improver saw ("Reference image N"), so the two stay coherent.
export function buildRefsManifest(
  refs: Array<{ role: FilmRefRole; label: string; url: string }>,
): string {
  if (refs.length === 0) return "";
  const lines = refs.map(
    (ref, index) =>
      `- Reference image ${index + 1} (${ref.role}${refLabelSuffix(ref.label)}): ${ref.url}`,
  );
  return [
    "Reference images (already uploaded to the studio - anchor the matching characters, locations, or visual style on them):",
    ...lines,
  ].join("\n");
}

// --- event subscriptions -------------------------------------------------------

function listenTauri(eventName: string, handler: (event: FilmEvent) => void): () => void {
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  void import("@tauri-apps/api/event")
    .then((api) =>
      api.listen<FilmEvent>(eventName, (event) => {
        if (!cancelled) handler(event.payload);
      }),
    )
    .then((stop) => {
      if (cancelled) stop?.();
      else unlisten = stop;
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/// Subscribe to the Rust watcher's re-emitted project events. Returns an
/// unlisten thunk; safe to call in a plain browser (no Tauri) — it just never
/// fires.
export function listenFilmEvents(handler: (event: FilmEvent) => void): () => void {
  return listenTauri(FILM_EVENT, handler);
}

/// Live tool progress of a streamed chat turn (`videomakerChat`).
export function listenFilmChatEvents(handler: (event: FilmEvent) => void): () => void {
  return listenTauri(FILM_CHAT_EVENT, handler);
}
