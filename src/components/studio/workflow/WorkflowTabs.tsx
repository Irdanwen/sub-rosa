// The workflows open on the canvas, one tab each. A tab says what its run is
// doing while another is on screen (running, waiting at a gate, failed,
// finished since it was last looked at), shows the workflow's picture on
// hover, and closes unless a run is going on in it.

import { IconCrossSmall } from "central-icons/IconCrossSmall";
import type { KeyboardEvent } from "react";
import type { StudioArtifact } from "../../../lib/studio/types";
import type { TabStatus } from "../../../lib/studio/workflow/run-sessions";
import type { Workflow } from "../../../lib/studio/workflow/schema";
import { t } from "../../../lib/i18n";
import { DotSpinner } from "../../DotSpinner";
import { HoverTip } from "../../ui/HoverTip";
import { CardPicture } from "../WorkflowLibrary";

function statusLabel(status: TabStatus): string {
  switch (status) {
    case "running":
      return t("Running");
    case "held":
      return t("Waiting for your approval");
    case "failed":
      return t("Failed");
    case "done":
      return t("Finished");
  }
}

export function WorkflowTabs({
  tabs,
  activeId,
  statusOf,
  artifactsById,
  onSelect,
  onClose,
}: {
  tabs: Workflow[];
  activeId: string | undefined;
  statusOf: (id: string) => TabStatus | undefined;
  artifactsById: ReadonlyMap<string, StudioArtifact>;
  onSelect: (workflow: Workflow) => void;
  onClose: (workflow: Workflow) => void;
}) {
  // One workflow open is nothing to switch between.
  if (tabs.length < 2) return null;

  const tabId = (workflow: Workflow) => `workflow-tab-${workflow.id}`;
  // Arrows move between tabs, as in any tab list; each tab opens as it is
  // reached, since opening one costs nothing.
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((workflow) => workflow.id === activeId);
    const index = (
      { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 } as Record<
        string,
        number
      >
    )[event.key];
    if (index === undefined) return;
    event.preventDefault();
    const target = tabs[(index + tabs.length) % tabs.length];
    if (!target) return;
    onSelect(target);
    document.getElementById(tabId(target))?.focus();
  };

  return (
    <div className="workflow-tabs" role="tablist" aria-label={t("Open workflows")} onKeyDown={move}>
      {tabs.map((workflow) => {
        const active = workflow.id === activeId;
        const status = statusOf(workflow.id);
        const name = workflow.name.trim() || t("Untitled workflow");
        const cover = workflow.coverArtifactId
          ? artifactsById.get(workflow.coverArtifactId)
          : undefined;
        return (
          <div
            key={workflow.id}
            className="workflow-tab"
            data-active={active || undefined}
            data-status={status}
          >
            <HoverTip
              className="workflow-tab-tip"
              width={220}
              tip={
                <span className="workflow-tab-preview">
                  <span className="workflow-tab-picture">
                    <CardPicture workflow={workflow} artifact={cover} />
                  </span>
                  <span className="workflow-tab-preview-name">{name}</span>
                  {status ? (
                    <span className="workflow-tab-preview-status">{statusLabel(status)}</span>
                  ) : null}
                </span>
              }
            >
              <button
                id={tabId(workflow)}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className="workflow-tab-button"
                aria-label={
                  status ? t("{name}, {status}", { name, status: statusLabel(status) }) : name
                }
                onClick={() => onSelect(workflow)}
              >
                {status === "running" ? (
                  <DotSpinner className="workflow-tab-mark" />
                ) : status ? (
                  <span className="workflow-tab-mark workflow-tab-dot" aria-hidden />
                ) : null}
                <span className="workflow-tab-name">{name}</span>
              </button>
            </HoverTip>
            {status === "running" ? null : (
              <button
                type="button"
                className="workflow-tab-close"
                aria-label={t("Close {name}", { name })}
                onClick={() => onClose(workflow)}
              >
                <IconCrossSmall size={14} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
