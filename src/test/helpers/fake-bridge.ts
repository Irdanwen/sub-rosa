import { vi } from "vitest";

/**
 * A fake of `src/lib/tauri` for App-level journeys.
 *
 * The real module exports a few hundred bindings; a journey touches a dozen.
 * The fake keeps every constant of the real module (event names the App
 * listens on), replaces every function with a resolved no-op, and lets the
 * test hand in the bindings it wants to script. A binding the test did not
 * script still exists, so a component that calls it in an effect degrades
 * the way it would on a bridge that answers "nothing" rather than crashing
 * the render; a binding the test asserts on is one it scripted.
 *
 * Usage, inside a `vi.mock("../lib/tauri", ...)` factory:
 *
 *   const actual = await vi.importActual<typeof import("../lib/tauri")>("../lib/tauri");
 *   return fakeBridge(actual, { bootstrapApp: mocks.bootstrapApp, ... });
 */
export function fakeBridge<M extends Record<string, unknown>>(
  actual: M,
  scripted: Partial<Record<keyof M, unknown>> & Record<string, unknown>,
): M {
  const fake: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actual)) {
    if (key in scripted) {
      fake[key] = scripted[key];
    } else if (typeof value === "function") {
      fake[key] = vi.fn(async () => undefined);
    } else {
      fake[key] = value;
    }
  }
  for (const [key, value] of Object.entries(scripted)) {
    if (!(key in fake)) fake[key] = value;
  }
  return fake as M;
}
