// Where the canvas is when it shows the inside of a block (ComfyUI's
// subgraph breadcrumb): the workflow, then each block step entered. A
// level above is one click away; what is edited here is the block itself,
// so every step that uses it changes.

import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { t } from "../../../lib/i18n";
import type { WorkflowBlock } from "../../../lib/studio/workflow/schema";
import type { ScopeLevel } from "./useBlockScope";

export function BlockBreadcrumb({
  workflowName,
  scope,
  blocks,
  onLeave,
}: {
  workflowName: string;
  scope: readonly ScopeLevel[];
  blocks: readonly WorkflowBlock[] | undefined;
  /** Come back up to this many levels deep (0: the workflow). */
  onLeave: (depth: number) => void;
}) {
  if (scope.length === 0) return null;
  const inside = blocks?.find((block) => block.id === scope.at(-1)?.blockId);
  return (
    <nav className="studio-block-breadcrumb" aria-label={t("Where you are in the workflow")}>
      <button type="button" className="studio-block-crumb" onClick={() => onLeave(0)}>
        {workflowName || t("Workflow")}
      </button>
      {scope.map((level, index) => {
        const block = blocks?.find((entry) => entry.id === level.blockId);
        const last = index === scope.length - 1;
        return (
          <span
            key={scope
              .slice(0, index + 1)
              .map((entry) => entry.instanceId)
              .join("/")}
            className="studio-block-crumb-level"
          >
            <IconChevronRightSmall size={14} aria-hidden />
            {last ? (
              <span className="studio-block-crumb" aria-current="location">
                {block?.name || t("Block")}
              </span>
            ) : (
              <button
                type="button"
                className="studio-block-crumb"
                onClick={() => onLeave(index + 1)}
              >
                {block?.name || t("Block")}
              </button>
            )}
          </span>
        );
      })}
      {inside ? (
        <span className="studio-block-crumb-note">
          {t("Changes here apply to every step that uses this block.")}
        </span>
      ) : null}
    </nav>
  );
}
