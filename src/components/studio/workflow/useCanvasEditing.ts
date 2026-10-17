// Editing the canvas the way a desktop editor does: undo and redo, copy,
// cut, paste (with connections when Shift is held), duplicate, select all,
// fit the view and run from the keyboard, and the same actions offered in
// the ⌘K palette while the canvas is open.
//
// Copy, cut and paste go through the DOM clipboard events, not keydown: the
// native Edit menu owns those shortcuts in the desktop app (lib.rs), and the
// events fire whether the menu or the keys did it, without asking the person
// for clipboard access.

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  type ContextualCommand,
  clearContextualCommands,
  setContextualCommands,
} from "../../../lib/contextual-commands";
import { t } from "../../../lib/i18n";
import { copySteps, pasteSteps, readClip } from "../../../lib/studio/workflow/clipboard";
import { GraphHistory, type GraphSnapshot } from "../../../lib/studio/workflow/history";
import { stableJson } from "../../../lib/studio/workflow/stable-json";

/** How long the graph sits still before a change becomes an undo step: one
 * drag, or one burst of typing, is one step. */
const SETTLE_MS = 350;

/** Keys typed into a field belong to the field. */
function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export interface CanvasEditing {
  undo: () => void;
  redo: () => void;
  duplicate: () => void;
}

export function useCanvasEditing(options: {
  /** The canvas is showing an editable workflow. */
  active: boolean;
  workflowId: string | undefined;
  graph: GraphSnapshot | undefined;
  selectedIds: () => Set<string>;
  applyGraph: (graph: GraphSnapshot) => void;
  addSteps: (graph: GraphSnapshot) => void;
  selectAll: () => void;
  removeSteps: (ids: Set<string>) => void;
  fitView: () => void;
  run: () => void;
  toggleHistory: () => void;
  /** Open the step search ("/"). */
  openSearch?: () => void;
  /** Frame the selected steps (⌘G). */
  frameSelection?: () => void;
  /** Make a block of the selected steps (⇧⌘E). */
  makeBlock?: () => void;
}): CanvasEditing {
  const history = useRef(new GraphHistory());
  const applying = useRef(false);
  const shiftHeld = useRef(false);
  const latest = useRef(options);
  latest.current = options;

  const graphKey = useMemo(() => (options.graph ? stableJson(options.graph) : ""), [options.graph]);

  // A freshly opened workflow starts a fresh history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the workflow's identity resets the history.
  useEffect(() => {
    if (options.graph) history.current.reset(options.graph);
  }, [options.workflowId]);

  // Every settled change is a step, except the one an undo just made.
  // biome-ignore lint/correctness/useExhaustiveDependencies: graphKey stands in for the graph.
  useEffect(() => {
    const graph = latest.current.graph;
    if (!graph) return;
    if (applying.current) {
      applying.current = false;
      return;
    }
    const timer = window.setTimeout(() => history.current.record(graph), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [graphKey]);

  const restore = useCallback((graph: GraphSnapshot | undefined) => {
    if (!graph) return;
    applying.current = true;
    latest.current.applyGraph(graph);
  }, []);
  const undo = useCallback(() => {
    const graph = latest.current.graph;
    // A change still settling is recorded first, so undo takes it back.
    if (graph) history.current.record(graph);
    restore(history.current.undo());
  }, [restore]);
  const redo = useCallback(() => restore(history.current.redo()), [restore]);

  const duplicate = useCallback(() => {
    const { graph, selectedIds, addSteps } = latest.current;
    const ids = selectedIds();
    const clip = graph && ids.size > 0 ? readClip(copySteps(graph, ids)) : undefined;
    if (!clip || !graph) return;
    addSteps(pasteSteps(clip, new Set(graph.nodes.map((node) => node.id)), true));
  }, []);

  useEffect(() => {
    if (!options.active) return;
    const onKey = (event: KeyboardEvent) => {
      shiftHeld.current = event.shiftKey;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      // ⌘↵ runs from anywhere, a prompt field included.
      if (mod && key === "enter") {
        event.preventDefault();
        latest.current.run();
        return;
      }
      if (typingInField(event.target)) return;
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (mod && key === "y") {
        event.preventDefault();
        redo();
      } else if (mod && key === "d") {
        event.preventDefault();
        duplicate();
      } else if (mod && event.shiftKey && key === "e") {
        event.preventDefault();
        latest.current.makeBlock?.();
      } else if (mod && key === "g") {
        event.preventDefault();
        latest.current.frameSelection?.();
      } else if (mod && key === "a") {
        event.preventDefault();
        latest.current.selectAll();
      } else if (!mod && !event.altKey && key === "f") {
        latest.current.fitView();
      } else if (!mod && !event.altKey && event.key === "/") {
        event.preventDefault();
        latest.current.openSearch?.();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      shiftHeld.current = event.shiftKey;
    };
    const onCopy = (event: ClipboardEvent, cut: boolean) => {
      if (typingInField(event.target) || typingInField(document.activeElement)) return;
      const { graph, selectedIds, removeSteps } = latest.current;
      const ids = selectedIds();
      if (!graph || ids.size === 0) return;
      event.clipboardData?.setData("text/plain", copySteps(graph, ids));
      event.preventDefault();
      if (cut) removeSteps(ids);
    };
    const copy = (event: ClipboardEvent) => onCopy(event, false);
    const cutSteps = (event: ClipboardEvent) => onCopy(event, true);
    const paste = (event: ClipboardEvent) => {
      if (typingInField(event.target) || typingInField(document.activeElement)) return;
      const clip = readClip(event.clipboardData?.getData("text/plain") ?? "");
      const graph = latest.current.graph;
      if (!clip || !graph) return;
      event.preventDefault();
      latest.current.addSteps(
        pasteSteps(clip, new Set(graph.nodes.map((node) => node.id)), shiftHeld.current),
      );
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    document.addEventListener("copy", copy);
    document.addEventListener("cut", cutSteps);
    document.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", cutSteps);
      document.removeEventListener("paste", paste);
    };
  }, [options.active, undo, redo, duplicate]);

  // The same actions in the ⌘K palette while the canvas is open.
  useEffect(() => {
    if (!options.active) return;
    const commands: ContextualCommand[] = [
      {
        id: "workflow:run",
        label: t("Run workflow"),
        shortcut: "⌘↵",
        run: () => latest.current.run(),
      },
      { id: "workflow:undo", label: t("Undo"), shortcut: "⌘Z", run: undo },
      { id: "workflow:redo", label: t("Redo"), shortcut: "⇧⌘Z", run: redo },
      {
        id: "workflow:duplicate",
        label: t("Duplicate selected steps"),
        shortcut: "⌘D",
        run: duplicate,
      },
      {
        id: "workflow:frame",
        label: t("Frame the selected steps"),
        shortcut: "⌘G",
        keywords: "group",
        run: () => latest.current.frameSelection?.(),
      },
      {
        id: "workflow:block",
        label: t("Make a block of the selected steps"),
        shortcut: "⇧⌘E",
        keywords: "group subgraph",
        run: () => latest.current.makeBlock?.(),
      },
      {
        id: "workflow:select-all",
        label: t("Select every step"),
        shortcut: "⌘A",
        run: () => latest.current.selectAll(),
      },
      {
        id: "workflow:fit",
        label: t("Fit the workflow in view"),
        shortcut: "F",
        run: () => latest.current.fitView(),
      },
      {
        id: "workflow:add-step",
        label: t("Add a step"),
        shortcut: "/",
        keywords: "node search new",
        run: () => latest.current.openSearch?.(),
      },
      {
        id: "workflow:history",
        label: t("Show run history"),
        keywords: "runs past",
        run: () => latest.current.toggleHistory(),
      },
    ];
    setContextualCommands("workflow-canvas", commands);
    return () => clearContextualCommands("workflow-canvas");
  }, [options.active, undo, redo, duplicate]);

  return { undo, redo, duplicate };
}
