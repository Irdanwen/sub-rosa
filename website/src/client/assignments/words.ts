/**
 * What Rust says about assignments (ADR-0091), read from the generated
 * export (`src-tauri/src/agent_lite/web_features/assignments.rs`): the two
 * travelling tables, the tool groups, the words of a run's prompt, the
 * clock's margins and the daily brief's rules. Nothing here is restated.
 */
import exported from "@subrosa/chat-core/web/assignments.json";
import { registerTables, type TableCodec } from "../codec";

export interface ToolGroup {
  id: string;
  /** The agent-lite tools the group turns on; `connectors` stands for every
   * connector tool. */
  lite: string[];
  /** Leaves the device or changes the machine: dropped under "ask first". */
  acts: boolean;
}

export interface AssignmentsExport {
  promptVersion: number;
  tables: Record<string, TableCodec>;
  toolGroups: ToolGroup[];
  feedbackInPrompt: number;
  maxResultInPrompt: number;
  words: {
    approvedBeforeTitle: string;
    approvedAfterTitle: string;
    taskBeforeTitle: string;
    taskAfterTitle: string;
    assignmentBeforeTitle: string;
    assignmentAfterTitle: string;
    askRule: string;
    actRule: string;
    approved: string;
    rejected: string;
    yourResult: string;
    resultOpen: string;
    resultClose: string;
    myFeedback: string;
    feedbackHeader: string;
    lateBeforeSlot: string;
    lateAfterSlot: string;
    summaryRule: string;
    eventCause: string;
    maxProposalChars: number;
  };
  clock: {
    lateAfterMinutes: number;
    fallbackGraceMinutes: number;
    runTimeoutHours: number;
    startTimeoutMinutes: number;
    carryOutDays: number;
  };
  limits: { titleChars: number; goalChars: number };
  jobTag: string;
  dailyBrief: {
    notifyWindowMinutes: number;
    maxTopics: number;
    maxTopicChars: number;
    linksPerTopic: number;
    maxNotes: number;
    maxFollowUps: number;
    maxItems: number;
    followUpHeadings: string[];
    defaultAtMinute: number;
    /** How long a device keeps its own travelling cards (ADR-0107). */
    keepDays: number;
  };
  vectors: {
    prompts: {
      input: {
        kind: string;
        title: string;
        goal: string;
        autonomy: "ask" | "act";
        lateFor: string | null;
        reviewed: {
          when: string;
          approved: boolean;
          feedback: string | null;
          result: string | null;
        }[];
        approvedProposal: string | null;
      };
      prompt: string;
    }[];
    summaries: { answer: string; summary: string }[];
    runIds: { assignmentId: string; slot: string; runId: string }[];
    followUps: { content: string; followUps: string[] }[];
    agendas: {
      events: { start: number; allDay: boolean; title: string; at: string }[];
      now: number;
      agenda: { count: number; firstTitle: string; firstAt: string } | null;
    }[];
    cardIds: { device: string; day: string; id: string }[];
  };
}

export const ASSIGNMENTS = exported as unknown as AssignmentsExport;

// The browser reads and writes these tables as the app does.
registerTables(ASSIGNMENTS.tables);
