/**
 * How the desktop tells an assignment's runs from routines (ADR-0091).
 *
 * Each run of an assignment is a one-shot Hermes cron job, so Hermes lists
 * it with the routines and keeps its session with the routine runs. The
 * Rust side names every such job with a machine tag before the
 * assignment's title (`ASSIGNMENT_JOB_TAG` in
 * `src-tauri/src/assignments/mod.rs`), and Hermes titles the run's session
 * from the job name. The tag is never translated and never shown: it is
 * read here, and only here.
 */

export const ASSIGNMENT_JOB_TAG = "[assignment] ";

/** The source an assignment's run session is given in place of "cron". */
export const ASSIGNMENT_RUN_SOURCE = "assignment";

/** Whether a job name, or a session title made from one, carries the tag. */
export function hasAssignmentTag(name: string | null | undefined) {
  return (name ?? "").trimStart().startsWith(ASSIGNMENT_JOB_TAG.trimEnd());
}

/** The name or title without the tag, for display. */
export function withoutAssignmentTag(name: string) {
  return hasAssignmentTag(name)
    ? name.trimStart().slice(ASSIGNMENT_JOB_TAG.trimEnd().length).trimStart()
    : name;
}
