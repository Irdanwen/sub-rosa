import { describe, expect, it, vi } from "vitest";
import { createHermesMethods } from "../lib/hermes-control-plane";

describe("dispatchGoalCommand — typed control-plane seam", () => {
  it("dispatches through command.dispatch with the name/arg params", async () => {
    const request = vi.fn(async () => ({ type: "exec", output: "No active goal." }));
    const methods = createHermesMethods(request);

    await methods.dispatchGoalCommand({ sessionId: "sess-1", arg: "" });

    // `goal` is a pending-input command: the pinned gateway's command.dispatch
    // reads only `name`/`arg` for those (a `command` string dispatches
    // nothing, verified against the live gateway), so the wire shape must
    // never regress to the /model-style `command` param.
    expect(request).toHaveBeenCalledWith("command.dispatch", {
      session_id: "sess-1",
      name: "goal",
      arg: "",
    });
  });

  it("passes goal text and control verbs through as the arg", async () => {
    const request = vi.fn(async () => ({
      type: "send",
      notice: "set",
      message: "ship the report",
    }));
    const methods = createHermesMethods(request);

    const result = await methods.dispatchGoalCommand({
      sessionId: "sess-2",
      arg: "ship the report",
    });

    expect(request).toHaveBeenCalledWith("command.dispatch", {
      session_id: "sess-2",
      name: "goal",
      arg: "ship the report",
    });
    // The gateway result flows back untouched: the caller reads `type` to
    // decide between showing `output` and submitting `message` as the kickoff.
    expect(result).toEqual({ type: "send", notice: "set", message: "ship the report" });
  });
});
