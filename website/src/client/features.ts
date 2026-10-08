/**
 * The web client's features, in the order they start, add to a turn and
 * tick (`feature.ts`). Protected mode comes first: its guards are in force
 * before any other feature, or the chat, sends anything.
 */
import { analysisFeature } from "./analysis";
import { assignmentRunsHere, assignmentsFeature, startEventRun } from "./assignments";
import { connectorsFeature, registerTriggerRunner } from "./connectors";
import { documentsFeature } from "./documents";
import type { FeatureHost, WebFeature } from "./feature";
import { financeFeature } from "./finance";
import { protectedFeature } from "./protected";
import { researchFeature } from "./research";
import { skillsFeature } from "./skills";
import { studyFeature } from "./study";
import { voiceFeature } from "./voice";

/** The latest host, for the connectors' triggers: an event they see starts
 * an assignment's run (ADR-0092), which needs the page as it is now. */
let latest: FeatureHost | null = null;
const currentHost: WebFeature = {
  id: "current-host",
  async start(host) {
    latest = host;
  },
  async tick(host) {
    latest = host;
  },
};
registerTriggerRunner({
  runsHere: (assignmentId) => latest !== null && assignmentRunsHere(latest, assignmentId),
  run: async (assignmentId, key, summary) => {
    if (latest) await startEventRun(latest, assignmentId, key, summary);
  },
});

export const WEB_FEATURES: WebFeature[] = [
  protectedFeature,
  currentHost,
  studyFeature,
  researchFeature,
  documentsFeature,
  analysisFeature,
  connectorsFeature,
  skillsFeature,
  financeFeature,
  assignmentsFeature,
  voiceFeature,
];
