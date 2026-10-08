/** What the web's data analysis reads from Rust
 * (`agent_lite/web_features/analysis.rs`): the tool, the card prompt, the
 * phone's limits and what the tool answers in each outcome (ADR-0101). */
import exported from "@subrosa/chat-core/web/analysis.json";
import type { ToolDefinition } from "../codec";

export interface AnalysisExport {
  tool: ToolDefinition;
  prompt: string;
  limits: {
    firstAnswerMs: number;
    runLimitMs: number;
    maxCodeChars: number;
    maxBlocks: number;
    maxBlockChars: number;
    maxStdoutChars: number;
  };
  messages: {
    needsPageOpen: string;
    unavailable: string;
    timedOut: string;
    stopped: string;
    noCode: string;
    tooLong: string;
    printedNothing: string;
    cards: string;
    noNetwork: string;
  };
}

export const ANALYSIS = exported as unknown as AnalysisExport;
