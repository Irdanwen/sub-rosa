// Another device's workflows reaching this one (ADR-0118): the library is
// read again on every sync event, and the open canvas follows what arrived
// for its workflow by `settleArrival`'s rules, after a run if one is live.

import { useCallback, useEffect, useRef } from "react";
import { useAccountSyncUpdated } from "../../../lib/account-sync-events";
import { settleArrival } from "../../../lib/studio/workflow/arrivals";
import type { Workflow } from "../../../lib/studio/workflow/schema";
import {
  listWorkflows,
  reloadWorkflowLibrary,
  storedWorkflow,
} from "../../../lib/studio/workflow/store";

export function useLibraryArrivals(options: {
  /** The whole workflow on the canvas, as the next save would write it. */
  serialized: Workflow | undefined;
  running: boolean;
  setWorkflows: (workflows: Workflow[]) => void;
  hydrate: (workflow: Workflow | undefined) => void;
}) {
  const { serialized, running, setWorkflows, hydrate } = options;
  const serializedRef = useRef(serialized);
  serializedRef.current = serialized;
  const runningRef = useRef(running);
  runningRef.current = running;
  /** The library's copy the canvas last agreed with, while an arrival waits. */
  const waiting = useRef<{ id: string; base: Workflow | undefined } | undefined>(undefined);

  const settle = useCallback(() => {
    const pending = waiting.current;
    const canvas = serializedRef.current;
    if (!pending || runningRef.current) return;
    waiting.current = undefined;
    // The person opened another workflow meanwhile: that one is up to date.
    if (canvas && canvas.id !== pending.id) return;
    const arrival = settleArrival({
      base: pending.base,
      fresh: storedWorkflow(pending.id),
      canvas,
    });
    if (arrival.kind === "open") hydrate(arrival.workflow);
    else if (arrival.kind === "gone") hydrate(listWorkflows()[0]);
  }, [hydrate]);

  useAccountSyncUpdated(async () => {
    const openId = serializedRef.current?.id;
    const base = openId ? storedWorkflow(openId) : undefined;
    if (!(await reloadWorkflowLibrary())) return;
    setWorkflows(listWorkflows());
    if (!openId) return;
    // A first arrival sets the copy to compare with; a second one while the
    // first waits must not replace it with a copy the canvas never showed.
    if (waiting.current?.id !== openId) waiting.current = { id: openId, base };
    settle();
  });

  useEffect(() => {
    if (!running) settle();
  }, [running, settle]);
}
