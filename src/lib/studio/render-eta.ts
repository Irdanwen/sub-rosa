/**
 * How long this render is likely to take, learned from the ones before it.
 *
 * A wait with no horizon is the anxious kind: at 30 seconds a rising counter
 * is fine, at three minutes it reads as a hang. Nothing upstream reports
 * progress - a queued render is opaque until the file lands - so the only
 * honest source of an estimate is this machine's own history with the same
 * model at the same length.
 *
 * Honest is the whole point, so the rules are strict. Two samples before we
 * say anything at all (one render is an anecdote, and a wrong estimate is
 * worse than none). The bar never reaches its end on an estimate: it eases
 * toward a ceiling and waits there, because the only thing that may claim the
 * render is finished is the finished render. And a miss is never re-labelled
 * as success - past the estimate the copy says so.
 *
 * Samples are per (kind, model, length) and local. They are a comfort, not a
 * contract: a wiped store just means indeterminate bars again.
 */

const STORAGE_KEY = "os-june:studio-render-eta";
/** Keep the recent past only - a provider that got slower this week should
 * show up in the estimate this week. */
const KEEP_SAMPLES = 8;
/** One render is an anecdote. Two is the least that can be a median. */
const MIN_SAMPLES = 2;
/** Guards against nonsense samples: a clock jump, or a row whose start time
 * came from a previous session's cold resume. */
const MIN_SAMPLE_MS = 1_000;
const MAX_SAMPLE_MS = 30 * 60_000;

/** What the bar tops out at while it is still only an estimate. */
const CEILING = 0.97;
/** Where the bar sits when the estimate runs out. The last stretch is the one
 * we know least about, so it gets the shallowest slope. */
const AT_ESTIMATE = 0.85;

type Store = Record<string, number[]>;

function readStore(): Store {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const store: Store = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        store[key] = value.filter((ms): ms is number => typeof ms === "number" && ms > 0);
      }
    }
    return store;
  } catch {
    // No storage (private mode, a test environment, a browser preview): the
    // estimate is a nicety, so its absence must never be an error.
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Same: a full or unavailable store costs an estimate, nothing else.
  }
}

/** The bucket a render's duration is remembered under.
 *
 * Model and kind only. Clip length would sharpen it - a 10 second render is
 * not a slow 5 second one - but length is not on the durable job row, so a
 * render that finished while the app was closed could not be filed under it,
 * and a bucket that only learns from renders you sat through is a bucket that
 * barely learns. The median over mixed lengths is coarser and always fed. */
export function renderEtaKey(kind: string, model: string | undefined): string {
  return `${kind}:${model ?? "unknown"}`;
}

/** File a finished render's wall time against its bucket. */
export function rememberRenderMs(key: string, elapsedMs: number): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_SAMPLE_MS || elapsedMs > MAX_SAMPLE_MS) {
    return;
  }
  const store = readStore();
  const samples = [...(store[key] ?? []), Math.round(elapsedMs)].slice(-KEEP_SAMPLES);
  store[key] = samples;
  writeStore(store);
}

/** The median of what this bucket has taken so far, or nothing when the
 * honest answer is that we do not know yet. */
export function estimateRenderMs(key: string): number | undefined {
  const samples = readStore()[key];
  if (!samples || samples.length < MIN_SAMPLES) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  // Median rather than mean: one render that stalled for ten minutes should
  // not drag every estimate after it.
  const median =
    sorted.length % 2 === 1
      ? sorted[middle]
      : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
  return median && median > 0 ? median : undefined;
}

/**
 * Where the bar should sit, from 0 to just under 1. Linear to
 * {@link AT_ESTIMATE} over the estimate, then asymptotic toward
 * {@link CEILING}: it keeps moving, so the wait never looks stuck, and it
 * never arrives, so it never lies. Undefined means "draw an indeterminate
 * bar" - not "draw zero".
 */
export function waitProgress(
  elapsedMs: number,
  estimateMs: number | undefined,
): number | undefined {
  if (!estimateMs || estimateMs <= 0 || !Number.isFinite(elapsedMs)) return undefined;
  const ratio = Math.max(0, elapsedMs) / estimateMs;
  if (ratio <= 1) return AT_ESTIMATE * ratio;
  return AT_ESTIMATE + (CEILING - AT_ESTIMATE) * (1 - Math.exp(-(ratio - 1) * 1.4));
}

/**
 * The words next to the clock. Rounded coarsely on purpose - "about 40s left"
 * is a promise we can keep, "37s left" is not - and it stops claiming to know
 * once the estimate has been passed.
 */
export function describeRemaining(
  elapsedMs: number,
  estimateMs: number | undefined,
): string | undefined {
  if (!estimateMs || estimateMs <= 0) return undefined;
  const left = estimateMs - elapsedMs;
  if (left <= 0) return "any moment now";
  if (left < 15_000) return "nearly there";
  if (left < 90_000) return `about ${Math.round(left / 10_000) * 10}s left`;
  return `about ${Math.round(left / 60_000)} min left`;
}
