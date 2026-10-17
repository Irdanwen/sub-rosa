import { MediaError } from "../client";

// --- surviving a rail that flaps ---------------------------------------------

/**
 * Two upstream failures that are not the node's fault, and not the end of a
 * production.
 *
 * A `402` from the payment rail and a `503` from provider capacity both come
 * and go in windows of ten or twenty minutes. Treated as node failures they
 * kill a run that has already paid for everything before them - which is
 * exactly how a film called "Rosa - Spot" died three times in one day on the
 * remote studio this replaces. The lesson was bought once and is not being
 * bought again: temporise and retry the same node.
 *
 * Deliberately not `isAsyncRetrySignal` and not the client's own retry: those
 * are for a request that should be re-sent in seconds. This is for waiting out
 * an outage without losing the run.
 */
export function isTransientSpendFailure(error: unknown): boolean {
  if (!(error instanceof MediaError)) return false;
  return error.status === 402 || error.status === 503;
}

/**
 * How long to wait before each retry, in order.
 *
 * Fifteen seconds to two minutes, then two minutes forever until the budget of
 * patience runs out. Bounded at ten minutes rather than the half hour the
 * remote studio used: a wallet that is genuinely empty gives the same 402 as a
 * rail that is flapping, and nobody wants to watch a run wait half an hour to
 * tell them so.
 */
export const TRANSIENT_WAIT_BUDGET_MS = 10 * 60 * 1000;

export function transientDelays(budgetMs: number = TRANSIENT_WAIT_BUDGET_MS): number[] {
  const delays: number[] = [];
  let spent = 0;
  for (const delay of [15_000, 30_000, 60_000, 120_000]) {
    if (spent + delay > budgetMs) return delays;
    delays.push(delay);
    spent += delay;
  }
  while (spent + 120_000 <= budgetMs) {
    delays.push(120_000);
    spent += 120_000;
  }
  return delays;
}

/**
 * Run a node, waiting out a flapping rail rather than failing the run.
 *
 * Every other error goes straight up: a bad prompt does not get better in two
 * minutes, and retrying it four times bills it four times.
 */
export async function withTransientTolerance<T>(
  work: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    budgetMs?: number;
    onWait?: (note: string) => void;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<T> {
  const delays = transientDelays(options.budgetMs ?? TRANSIENT_WAIT_BUDGET_MS);
  const sleeper = options.sleep ?? wait;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isTransientSpendFailure(error)) throw error;
      const reason =
        error instanceof MediaError && error.status === 402
          ? "The payment rail turned this down"
          : "There is no provider capacity right now";
      options.onWait?.(`${reason}. Trying again in ${Math.round(delay / 1000)}s.`);
      await sleeper(delay, options.signal);
    }
  }
}

export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The workflow run was cancelled.", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
