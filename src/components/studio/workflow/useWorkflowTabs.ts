// The workflows open as tabs on the canvas (tabs.ts): opening a workflow
// adds its tab, a deleted workflow takes its tab with it, and leaving a tab
// saves its last edit first. What each tab's run is doing lives in the run
// sessions; this hook only decides which tabs there are.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunSessions } from "../../../lib/studio/workflow/run-sessions";
import type { Workflow } from "../../../lib/studio/workflow/schema";
import { listWorkflows, workflowLibraryLoaded } from "../../../lib/studio/workflow/store";
import { closeTab, openTab, readTabs, writeTabs } from "../../../lib/studio/workflow/tabs";

export function useWorkflowTabs(options: {
  view: "library" | "canvas";
  current: Workflow | undefined;
  workflows: Workflow[];
  sessions: RunSessions;
  /** Save the open canvas now rather than after the debounce. */
  flushSave: () => void;
  openWorkflow: (workflow: Workflow) => void;
  toLibrary: () => void;
}) {
  const { view, current, workflows, sessions, flushSave, openWorkflow } = options;
  const toLibraryRef = useRef(options.toLibrary);
  toLibraryRef.current = options.toLibrary;
  const currentRef = useRef(current);
  currentRef.current = current;
  const [tabs, setTabs] = useState<string[]>(readTabs);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const currentId = current?.id;
  useEffect(() => {
    if (view !== "canvas" || !currentId) return;
    setTabs((open) => openTab(open, currentId, (id) => sessions.running(id)));
  }, [view, currentId, sessions]);
  useEffect(() => writeTabs(tabs), [tabs]);
  // A workflow deleted here or elsewhere takes its tab with it.
  useEffect(() => {
    if (!workflowLibraryLoaded()) return;
    setTabs((open) => {
      const kept = open.filter(
        (id) => id === currentRef.current?.id || workflows.some((entry) => entry.id === id),
      );
      return kept.length === open.length ? open : kept;
    });
  }, [workflows]);

  const select = useCallback(
    (workflow: Workflow) => {
      if (workflow.id === currentRef.current?.id) return;
      flushSave();
      openWorkflow(listWorkflows().find((entry) => entry.id === workflow.id) ?? workflow);
    },
    [flushSave, openWorkflow],
  );

  const close = useCallback(
    (workflow: Workflow) => {
      const shown = currentRef.current?.id;
      const { tabs: remaining, next } = closeTab(tabsRef.current, workflow.id, shown);
      setTabs(remaining);
      sessions.seen(workflow.id);
      if (workflow.id !== shown) return;
      flushSave();
      const target = next ? listWorkflows().find((entry) => entry.id === next) : undefined;
      if (target) openWorkflow(target);
      else toLibraryRef.current();
    },
    [sessions, flushSave, openWorkflow],
  );

  const open = tabs.flatMap((id) => {
    if (current && id === current.id) return [current];
    const found = workflows.find((entry) => entry.id === id);
    return found ? [found] : [];
  });

  return { open, select, close };
}
