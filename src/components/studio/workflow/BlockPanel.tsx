// The face a block shows the workflow, edited from inside it: its name,
// which inner inputs it takes, which inner results it gives, and which
// inner settings every block step shows (ComfyUI's subgraph inputs, outputs
// and promoted widgets). Taking an input or a result away also takes off
// the wires that used it.

import { t } from "../../../lib/i18n";
import {
  togglePromoted,
  toggleBlockInput,
  toggleBlockOutput,
} from "../../../lib/studio/workflow/blocks";
import { paramLabel, portLabel } from "../../../lib/studio/workflow/labels";
import {
  maybeNodeSchema,
  nodeLabel,
  openInputPorts,
  type WorkflowBlock,
} from "../../../lib/studio/workflow/schema";

export function BlockPanel({
  block,
  onChange,
}: {
  block: WorkflowBlock;
  onChange: (next: WorkflowBlock) => void;
}) {
  const steps = block.nodes.filter((node) => node.type !== "note" && node.type !== "relay");
  return (
    <details className="studio-block-panel">
      <summary>{t("What this block takes, gives and shows")}</summary>
      <label className="studio-block-panel-name">
        <span>{t("Block name")}</span>
        <input
          className="studio-input"
          value={block.name}
          onChange={(event) => onChange({ ...block, name: event.target.value })}
        />
      </label>
      <div className="studio-block-panel-columns">
        <fieldset>
          <legend>{t("It takes")}</legend>
          {steps.flatMap((node) => {
            const schema = maybeNodeSchema(node.type);
            if (!schema || node.type === "block") return [];
            return openInputPorts(schema, node.params).map((port) => {
              const label = portLabel(node.type, port);
              const taken = block.inputs.some(
                (input) => input.nodeId === node.id && input.port === port.id,
              );
              return (
                <label key={`${node.id}:${port.id}`} className="studio-block-panel-choice">
                  <input
                    type="checkbox"
                    checked={taken}
                    onChange={() => onChange(toggleBlockInput(block, node.id, port.id, label))}
                  />
                  {nodeLabel(node)} · {label}
                </label>
              );
            });
          })}
        </fieldset>
        <fieldset>
          <legend>{t("It gives")}</legend>
          {steps
            .filter((node) => maybeNodeSchema(node.type)?.output !== "none")
            .map((node) => (
              <label key={node.id} className="studio-block-panel-choice">
                <input
                  type="checkbox"
                  checked={block.outputs.some(
                    (output) => output.nodeId === node.id && !output.port,
                  )}
                  onChange={() => onChange(toggleBlockOutput(block, node.id, nodeLabel(node)))}
                />
                {nodeLabel(node)}
              </label>
            ))}
        </fieldset>
        <fieldset>
          <legend>{t("It shows")}</legend>
          {steps.flatMap((node) =>
            (node.type === "block" ? [] : (maybeNodeSchema(node.type)?.params ?? [])).map(
              (param) => (
                <label key={`${node.id}:${param.name}`} className="studio-block-panel-choice">
                  <input
                    type="checkbox"
                    checked={block.promoted.some(
                      (entry) => entry.nodeId === node.id && entry.param === param.name,
                    )}
                    onChange={() => onChange(togglePromoted(block, node.id, param.name))}
                  />
                  {nodeLabel(node)} · {paramLabel(param)}
                </label>
              ),
            ),
          )}
        </fieldset>
      </div>
    </details>
  );
}
