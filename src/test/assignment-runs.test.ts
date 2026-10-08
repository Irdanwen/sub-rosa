import { describe, expect, it } from "vitest";
import rust from "../../src-tauri/src/assignments/mod.rs?raw";
import {
  ASSIGNMENT_JOB_TAG,
  ASSIGNMENT_RUN_SOURCE,
  hasAssignmentTag,
  withoutAssignmentTag,
} from "../lib/assignment-runs";
import { normalizeHermesSessionsResponse } from "../lib/hermes-adapter";
import {
  assignmentJobIds,
  routinesOnly,
  withoutAssignmentRuns,
  type RoutineJob,
} from "../lib/hermes-routines";

/**
 * An assignment's runs ride on one-shot Hermes cron jobs (ADR-0091). The Rust
 * side names them with a machine tag, and the webview keeps them out of the
 * Routines list and history by that tag, never by a translated name.
 */
describe("the assignment job tag", () => {
  it("is the one the Rust side writes", () => {
    const written = /pub const ASSIGNMENT_JOB_TAG: &str = "([^"]*)";/.exec(rust)?.[1];
    expect(written).toBe(ASSIGNMENT_JOB_TAG);
  });

  it("is read and removed for display", () => {
    expect(hasAssignmentTag("[assignment] Veille énergie")).toBe(true);
    expect(hasAssignmentTag("Assignment: Veille énergie")).toBe(false);
    expect(hasAssignmentTag(undefined)).toBe(false);
    expect(withoutAssignmentTag("[assignment] Veille énergie · Oct 08 09:00")).toBe(
      "Veille énergie · Oct 08 09:00",
    );
    expect(withoutAssignmentTag("Morning summary")).toBe("Morning summary");
  });
});

function job(job_id: string, name: string): RoutineJob {
  return {
    job_id,
    name,
    prompt: "",
    prompt_preview: "",
    schedule: "1m",
    repeat: "1x",
    deliver: "local",
    created_at: null,
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    enabled: true,
    state: "scheduled",
  };
}

describe("routines without assignments", () => {
  const jobs = [job("r1", "Morning summary"), job("a1", "[assignment] Watch the tenders")];

  it("separates the jobs", () => {
    expect(routinesOnly(jobs).map((entry) => entry.job_id)).toEqual(["r1"]);
    expect([...assignmentJobIds(jobs)]).toEqual(["a1"]);
  });

  it("drops running and finished assignment runs from the history", () => {
    const runs = [
      { id: "cron_r1_20261008_090000", source: "cron" },
      { id: "cron_a1_20261008_090000", source: "cron" },
      { id: "cron_gone_20261007_090000", source: ASSIGNMENT_RUN_SOURCE },
    ];
    expect(withoutAssignmentRuns(runs, assignmentJobIds(jobs)).map((run) => run.id)).toEqual([
      "cron_r1_20261008_090000",
    ]);
  });

  it("gives a finished run its own source and the assignment's title", () => {
    const [session] = normalizeHermesSessionsResponse({
      sessions: [
        {
          id: "cron_a1_20261008_090000",
          source: "cron",
          title: "[assignment] Watch the tenders · Oct 08 09:00",
          preview: "Two new tenders.",
        },
      ],
    });
    expect(session.source).toBe(ASSIGNMENT_RUN_SOURCE);
    expect(session.title).toBe("Watch the tenders · Oct 08 09:00");
    // A routine run is left as it was.
    const [routine] = normalizeHermesSessionsResponse({
      sessions: [{ id: "cron_r1_20261008_090000", source: "cron", title: "Morning summary" }],
    });
    expect(routine.source).toBe("cron");
  });
});
