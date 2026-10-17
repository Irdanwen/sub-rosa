// The canvas's toolbar: where the workflow goes (library, new), what edits it
// (undo, redo, add a step, arrange), what it remembers (history, versions),
// and what it costs and runs.

import { IconArrowRedoDown } from "central-icons/IconArrowRedoDown";
import { IconArrowUndoUp } from "central-icons/IconArrowUndoUp";
import type { ReactNode, RefObject } from "react";
import { t } from "../../../lib/i18n";
import type { WorkflowCostEstimate } from "../../../lib/studio/workflow";
import { nodeTypeLabel } from "../../../lib/studio/workflow/labels";
import { NODE_SCHEMAS, type WorkflowNodeType } from "../../../lib/studio/workflow/schema";
import { Select } from "../../ui/Select";
import { costSummary } from "./RunCostDialog";

export function WorkflowToolbar(props: {
  libraryButtonRef: RefObject<HTMLButtonElement>;
  onLibrary: () => void;
  name: string;
  onRename: (name: string) => void;
  onNew: () => void;
  readOnly: boolean;
  hasWorkflow: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAddNode: (type: WorkflowNodeType) => void;
  arranging: boolean;
  canArrange: boolean;
  onArrange: () => void;
  historyOpen: boolean;
  onHistory: () => void;
  versionsOpen: boolean;
  onVersions: () => void;
  onDelete: () => void;
  estimate: WorkflowCostEstimate | undefined;
  running: boolean;
  onStop: () => void;
  canRun: boolean;
  runIssues: string | undefined;
  quoting: boolean;
  onRun: () => void;
  onHoverRun: (hovering: boolean) => void;
  /** Between the editing controls and the run: the graph or app switch. */
  modeSwitch?: ReactNode;
  /** Shown as an app: the graph's tools and the run are the form's. */
  asApp?: boolean;
}) {
  const { estimate } = props;
  return (
    <div className="studio-workflows-toolbar">
      <button
        ref={props.libraryButtonRef}
        type="button"
        className="btn btn-secondary"
        onClick={props.onLibrary}
      >
        {t("Library")}
      </button>
      <input
        className="studio-input studio-workflow-name"
        value={props.name}
        placeholder={t("Workflow name")}
        aria-label={t("Workflow name")}
        onChange={(event) => props.onRename(event.target.value)}
      />
      <button type="button" className="btn btn-secondary" onClick={props.onNew}>
        {t("New")}
      </button>
      <button
        type="button"
        className="studio-icon-button"
        aria-label={t("Undo")}
        title={t("Undo (⌘Z)")}
        disabled={props.readOnly}
        onClick={props.onUndo}
      >
        <IconArrowUndoUp size={16} />
      </button>
      <button
        type="button"
        className="studio-icon-button"
        aria-label={t("Redo")}
        title={t("Redo (⇧⌘Z)")}
        disabled={props.readOnly}
        onClick={props.onRedo}
      >
        <IconArrowRedoDown size={16} />
      </button>
      {props.asApp ? null : (
        <Select
          value={null}
          placeholder={t("Add node")}
          ariaLabel={t("Add a node")}
          onChange={(type) => props.onAddNode(type as WorkflowNodeType)}
          options={Object.values(NODE_SCHEMAS)
            .filter((schema) => schema.type !== "block" && schema.type !== "listItem")
            .map((schema) => ({ value: schema.type, label: nodeTypeLabel(schema.type) }))}
        />
      )}
      {props.asApp ? null : (
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={props.arranging}
          disabled={!props.hasWorkflow || props.readOnly || !props.canArrange}
          onClick={props.onArrange}
        >
          {t("Arrange")}
        </button>
      )}
      <button
        type="button"
        className="btn btn-secondary"
        aria-pressed={props.historyOpen}
        disabled={!props.hasWorkflow}
        onClick={props.onHistory}
      >
        {t("History")}
      </button>
      <button
        type="button"
        className="btn btn-secondary"
        aria-pressed={props.versionsOpen}
        disabled={!props.hasWorkflow}
        onClick={props.onVersions}
      >
        {t("Versions")}
      </button>
      {props.modeSwitch}
      <span className="studio-spacer" />
      {props.hasWorkflow ? (
        <button type="button" className="btn btn-secondary" onClick={props.onDelete}>
          {t("Delete")}
        </button>
      ) : null}
      {!props.asApp && estimate && (estimate.credits > 0 || estimate.metered > 0) ? (
        <span className="studio-workflow-cost" title={t("Estimated cost of one run")}>
          {costSummary(estimate)}
        </span>
      ) : null}
      {props.asApp ? null : <RunButton {...props} />}
    </div>
  );
}

/** Run, or Stop while a run goes on; shared by the canvas and the app. */
export function RunButton(props: {
  running: boolean;
  onStop: () => void;
  canRun: boolean;
  readOnly: boolean;
  runIssues: string | undefined;
  quoting: boolean;
  onRun: () => void;
  onHoverRun?: (hovering: boolean) => void;
}) {
  if (props.running)
    return (
      <button type="button" className="btn btn-secondary" onClick={props.onStop}>
        {t("Stop")}
      </button>
    );
  return (
    <button
      type="button"
      className="studio-primary-button"
      disabled={!props.canRun || props.quoting || props.readOnly}
      title={props.runIssues}
      onClick={props.onRun}
      onPointerEnter={() => props.onHoverRun?.(true)}
      onPointerLeave={() => props.onHoverRun?.(false)}
      onFocus={() => props.onHoverRun?.(true)}
      onBlur={() => props.onHoverRun?.(false)}
    >
      {props.quoting ? t("Pricing...") : t("Run workflow")}
    </button>
  );
}
