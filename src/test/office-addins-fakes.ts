import type { Operator } from "../../website/src/client/carpe-diem";
import type { Engine } from "../../office-addins/src/model";
import { fakeOperator, type Script } from "./website-client-fakes";

/** A pane engine over a scripted operator, with a key always there. */
export function fakeEngine(answer: Script): {
  engine: Engine;
  calls: { path: string; body: Record<string, unknown> }[];
  operator: Operator;
} {
  const { operator, calls } = fakeOperator(answer);
  return {
    engine: { operator, model: "test-model", openKey: async () => "cdm_test" },
    calls,
    operator,
  };
}

/** The last user message of a completion request. */
export function lastUser(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: string }[];
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
}
