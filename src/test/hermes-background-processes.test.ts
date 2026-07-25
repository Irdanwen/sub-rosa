import { describe, expect, it } from "vitest";
import { classifyHermesEvent } from "../lib/hermes-control-plane";
import {
  BACKGROUND_PROCESSES_PER_SESSION_CAP,
  createHermesBackgroundProcessStore,
  hasRunningBackgroundWork,
} from "../lib/hermes-background-processes";

const AT = "2026-07-25T10:00:00.000Z";

/** Feeds a raw frame through the real classifier, like the workspace does. */
function record(
  store: ReturnType<typeof createHermesBackgroundProcessStore>,
  raw: Record<string, unknown>,
  receivedAt = AT,
) {
  // The workspace passes the STORED session id; the frames carry the runtime
  // one. The fixtures use "s1" for both so the tests stay readable, but the
  // store must never read it off the frame.
  store.record(classifyHermesEvent(raw as never), { sessionId: "s1", receivedAt });
}

const backgroundLaunch = (overrides: Record<string, unknown> = {}) => ({
  type: "tool.start",
  session_id: "s1",
  payload: {
    tool_call_id: "call-1",
    name: "terminal",
    arguments: { command: "python run_benchmark.py --all", background: true },
    ...overrides,
  },
});

describe("hermesBackgroundProcessStore", () => {
  it("tracks a background shell launch with its command as the label", () => {
    const store = createHermesBackgroundProcessStore();
    record(store, backgroundLaunch());

    expect(store.forSession("s1")).toEqual([
      {
        id: "call-1",
        sessionId: "s1",
        label: "python run_benchmark.py --all",
        status: "running",
        startedAt: AT,
      },
    ]);
    expect(hasRunningBackgroundWork(store.forSession("s1"))).toBe(true);
  });

  it("ignores a foreground tool call", () => {
    // The store must never claim background work from an ordinary command: a
    // banner saying a job is running when none is would be worse than none.
    const store = createHermesBackgroundProcessStore();
    record(store, {
      type: "tool.start",
      session_id: "s1",
      payload: { tool_call_id: "call-1", name: "terminal", arguments: { command: "ls" } },
    });
    record(store, backgroundLaunch({ arguments: { command: "ls", background: false } }));
    expect(store.forSession("s1")).toEqual([]);
  });

  it("prefers the runtime's handle over the tool call id", () => {
    const store = createHermesBackgroundProcessStore();
    record(
      store,
      backgroundLaunch({
        arguments: { command: "make build", background: true, handle: "bg-7" },
      }),
    );
    expect(store.forSession("s1")[0]?.id).toBe("bg-7");
  });

  it("ends a process on its lifecycle frame, whatever carries the verdict", () => {
    const store = createHermesBackgroundProcessStore();
    record(store, backgroundLaunch({ arguments: { command: "make build", background: true } }));
    // `status` shadows the raw type in the classified event, so a frame with a
    // status field is still recognized as a background lifecycle by rawType.
    record(
      store,
      {
        type: "background.update",
        session_id: "s1",
        payload: { handle: "call-1", status: "exited" },
      },
      "2026-07-25T10:12:00.000Z",
    );
    expect(store.forSession("s1")[0]).toMatchObject({
      status: "finished",
      finishedAt: "2026-07-25T10:12:00.000Z",
      // The elapsed clock the banner shows must not be reset by later frames.
      startedAt: AT,
    });
    expect(hasRunningBackgroundWork(store.forSession("s1"))).toBe(false);
  });

  it("recognizes a bare background.complete with no status field", () => {
    const store = createHermesBackgroundProcessStore();
    record(store, backgroundLaunch());
    record(store, {
      type: "background.complete",
      session_id: "s1",
      payload: { handle: "call-1" },
    });
    expect(store.forSession("s1")[0]?.status).toBe("finished");
  });

  it("never resurrects a finished process, and never restarts its clock", () => {
    const store = createHermesBackgroundProcessStore();
    record(store, backgroundLaunch());
    record(store, { type: "background.complete", session_id: "s1", payload: { handle: "call-1" } });
    // A late duplicate launch frame (reconnect replay) must not undo the end.
    record(store, backgroundLaunch(), "2026-07-25T11:00:00.000Z");
    expect(store.forSession("s1")[0]).toMatchObject({ status: "finished", startedAt: AT });
  });

  it("ignores background frames it cannot identify", () => {
    const store = createHermesBackgroundProcessStore();
    record(store, { type: "background.complete", session_id: "s1", payload: {} });
    record(store, { type: "background.start", session_id: "s1" });
    expect(store.forSession("s1")).toEqual([]);
  });

  it("files under the caller's stored session id, not the frame's runtime id", () => {
    // The frames carry the live runtime session id; every UI surface keys by
    // the stored one. Reading it off the frame would file each process under an
    // id nothing ever looks up — a store that silently collects nothing.
    const store = createHermesBackgroundProcessStore();
    store.record(
      classifyHermesEvent({
        type: "tool.start",
        session_id: "runtime-session-1",
        payload: {
          tool_call_id: "call-1",
          name: "terminal",
          arguments: { command: "make build", background: true },
        },
      } as never),
      { sessionId: "stored-session-1", receivedAt: AT },
    );
    expect(store.forSession("runtime-session-1")).toEqual([]);
    expect(store.forSession("stored-session-1")).toHaveLength(1);
  });

  it("clears finished rows without touching running ones", () => {
    const store = createHermesBackgroundProcessStore();
    record(store, backgroundLaunch());
    record(
      store,
      backgroundLaunch({
        tool_call_id: "call-2",
        arguments: { command: "npm test", background: true },
      }),
    );
    record(store, { type: "background.complete", session_id: "s1", payload: { handle: "call-1" } });

    store.clearFinished("s1");
    expect(store.forSession("s1").map((row) => row.id)).toEqual(["call-2"]);

    store.clearSession("s1");
    expect(store.forSession("s1")).toEqual([]);
  });

  it("notifies subscribers and bounds each session", () => {
    const store = createHermesBackgroundProcessStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    record(store, backgroundLaunch());
    expect(notifications).toBe(1);
    unsubscribe();
    record(store, backgroundLaunch({ tool_call_id: "call-2" }));
    expect(notifications).toBe(1);

    for (let index = 0; index < BACKGROUND_PROCESSES_PER_SESSION_CAP + 5; index += 1) {
      record(store, backgroundLaunch({ tool_call_id: `bulk-${index}` }));
    }
    expect(store.forSession("s1").length).toBe(BACKGROUND_PROCESSES_PER_SESSION_CAP);
  });
});
