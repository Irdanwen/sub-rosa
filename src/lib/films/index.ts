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
};

export type FilmRun = {
  id: string;
  status: string;
  detail?: string;
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
  };
}

export function parseRun(raw: unknown): FilmRun | null {
  const run = record(record(raw).run ?? raw);
  const id = str(run.id);
  if (!id) return null;
  return { id, status: str(run.status) ?? "running", detail: str(run.detail) };
}

/// The produce handshake payload (flattened by the Rust command: a 409 quote
/// comes back as a success payload with needs_confirmation).
export function parseProduceOutcome(raw: unknown): {
  started: boolean;
  needsConfirmation: boolean;
  projectedCostDiem?: number;
} {
  const body = record(raw);
  return {
    started: body.started === true,
    needsConfirmation: body.needs_confirmation === true,
    projectedCostDiem:
      typeof body.projected_cost_diem === "number" ? body.projected_cost_diem : undefined,
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
