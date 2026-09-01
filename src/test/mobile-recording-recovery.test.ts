import { describe, expect, it } from "vitest";

/**
 * An interrupted recording must be recoverable on the phone too.
 *
 * The audio survives a crash, a reboot or a flat battery: Rust writes it to
 * disk, `bootstrap_app` returns the pending recoveries, `recover_recording` is
 * registered in both command lists, and the shared NoteEditor already renders
 * the prompt. Everything was in place except the last three props, which the
 * phone passed as `() => undefined` -- so the app knew a recording could be
 * saved, showed nothing, and the only irreversible loss in the whole product
 * happened in silence.
 *
 * This reads the source rather than mounting the shell: MobileApp pulls in the
 * entire mobile world (audio, studio, event listeners) and what has to hold
 * here is narrow and structural -- that the wiring is a real handler and never
 * goes back to a stub. Sources come through `import.meta.glob` rather than
 * `node:fs`, which is the seam this repo settled on for tests that look at the
 * code instead of running it.
 */

const SOURCES = import.meta.glob("../{app,components}/**/*.tsx", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

function source(suffix: string): string {
  const key = Object.keys(SOURCES).find((path) => path.endsWith(suffix));
  // A glob that quietly matches nothing leaves a guard of this shape passing
  // forever, which is the one way it fails without saying so.
  if (!key) throw new Error(`no source matched ${suffix}`);
  return SOURCES[key] as string;
}

const mobileApp = source("app/mobile/MobileApp.tsx");
const noteDetail = source("components/mobile/screens/NoteDetailScreen.tsx");

describe("recording recovery on the phone", () => {
  it("passes a real handler, not a stub", () => {
    expect(noteDetail).not.toMatch(/onRecoverRecording=\{\(\) => undefined\}/);
    expect(noteDetail).not.toMatch(/onDiscardRecording=\{\(\) => undefined\}/);
    expect(noteDetail).toMatch(/onRecoverRecording=\{onRecoverRecording\}/);
    expect(noteDetail).toMatch(/onDiscardRecording=\{onDiscardRecording\}/);
  });

  it("hands the prompt the recovery it is about", () => {
    // Without this the prompt never renders, however well the buttons are wired.
    expect(noteDetail).toMatch(/recovery=\{recovery\}/);
    expect(mobileApp).toMatch(/recovery=\{selectedRecovery\}/);
  });

  it("calls the command both ways", () => {
    expect(mobileApp).toMatch(/recoverRecording\(sessionId, action\)/);
    expect(mobileApp).toMatch(/handleRecovery\(sessionId, "validate"\)/);
    expect(mobileApp).toMatch(/handleRecovery\(sessionId, "discard"\)/);
  });

  it("clears the recovery from state once it is settled", () => {
    // Otherwise the prompt returns on the next render and the note reads as
    // having failed twice.
    expect(mobileApp).toMatch(/type: "recoveryRemoved", sessionId/);
  });
});
