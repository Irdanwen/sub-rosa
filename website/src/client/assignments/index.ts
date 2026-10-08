/**
 * The web client's assignments, scheduled tasks and daily brief (ADR-0091).
 * A tab on `/app` is an open app: every minute while it is open, the page
 * runs what is due here and writes the day's brief when it is owed. Nothing
 * runs on the account service, and nothing runs when the tab is closed.
 */
import { t } from "../../lib/i18n";
import type { WebFeature } from "../feature";
import { briefTick } from "./brief";
import { AssignmentsPanel } from "./Panel";
import { tick } from "./runner";

export { assignmentRunsHere, evaluatesHere, startEventRun } from "./runner";

export const assignmentsFeature: WebFeature = {
  id: "assignments",
  label: () => t("Assignments", "Missions"),
  Panel: AssignmentsPanel,
  async tick(host, signal) {
    await tick(host);
    if (!signal.aborted) await briefTick(host, new Date(), signal);
  },
};
