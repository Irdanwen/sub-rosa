// The canvas node: header, ports, settings, ordering lists, the gate's
// approval controls and the node's output.

import { t } from "../../../lib/i18n";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useState } from "react";
import { formatCredits } from "../../../lib/studio/catalog";
import type { ReferenceRole } from "../../../lib/studio/kling";
import { referenceMentions } from "../../../lib/studio/seedance";
import {
  estimateNodeCost,
  paramApplies,
  nodeSchema,
  openInputPorts,
} from "../../../lib/studio/workflow";
import { Spinner } from "../../ui/Spinner";
import type { StudioNodeData, StudioFlowNode } from "./flow";
import { ParamField } from "./ParamField";
import { NodeOutputView } from "./NodeOutputView";

/** The controls a gate shows while it holds the production: pick a candidate
 * (when several are wired in) and approve. */
function GateApproval({ data }: { data: StudioNodeData }) {
  const sources = data.gateSources ?? [];
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const note = typeof data.wfNode.params.note === "string" ? data.wfNode.params.note.trim() : "";
  // A judged gate stopped with an opinion. Showing it is the whole reason the
  // judge ran before holding rather than after being asked.
  const verdict = data.result?.note;
  return (
    <div className="studio-gate-approval nodrag">
      <p className="studio-gate-note">
        {note || t("The production is waiting for your approval.")}
      </p>
      {verdict ? <p className="studio-gate-verdict">{verdict}</p> : null}
      {sources.length > 1 ? (
        <select
          className="studio-native-select nodrag"
          value={choice ?? sources[0]?.id ?? ""}
          aria-label={t("Candidate to continue with")}
          onChange={(event) => setChoice(event.target.value)}
        >
          {sources.map((source, index) => (
            <option key={source.id} value={source.id}>
              {index === 0
                ? t("{index}. {name} (default)", { index: index + 1, name: source.label })
                : `${index + 1}. ${source.label}`}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        className="studio-primary-button"
        onClick={() => data.onApproveGate?.(data.wfNode.id, choice ?? sources[0]?.id)}
      >
        {t("Approve and continue")}
      </button>
    </div>
  );
}

export function StudioNode({ data }: NodeProps<StudioFlowNode>) {
  const { wfNode, catalog, result, onParamsChange, onRemove } = data;
  const schema = nodeSchema(wfNode.type);
  // The inputs this node carries: its model can close some of them, and a
  // port that is not drawn is a port nothing can be wired to.
  const inputs = openInputPorts(schema, wfNode.params);
  const cost = estimateNodeCost(wfNode, catalog);
  const runState =
    result?.status === "running"
      ? "running"
      : result?.status === "done"
        ? "done"
        : result?.status === "error"
          ? "error"
          : result?.status === "awaiting"
            ? "awaiting"
            : undefined;
  return (
    <div className="studio-node" data-run={runState}>
      <div className="studio-node-head">
        {/* The name is the node's own, and its type stands in as the
            placeholder until it has one: three asset nodes all reading
            "Asset" is exactly what naming them is for, and the connection
            lists, the gate candidates and the cost breakdown all read it. */}
        <input
          className="studio-node-title nodrag"
          value={wfNode.label}
          placeholder={schema.label}
          aria-label={t("{type} name", { type: schema.label })}
          onChange={(event) => data.onRename(wfNode.id, event.target.value)}
        />
        <span className="studio-card-actions">
          {wfNode.label.trim() ? (
            // Named, so the type no longer shows in the title. Keep it legible.
            <span className="studio-node-kind">{schema.label}</span>
          ) : null}
          {cost.kind === "flat" && cost.credits !== undefined && cost.credits > 0 ? (
            <span className="studio-node-kind">~{formatCredits(cost.credits)}</span>
          ) : null}
          {result?.status === "running" && typeof result.progress === "number" ? (
            <span className="studio-node-kind">{Math.round(result.progress * 100)}%</span>
          ) : null}
          {result?.status === "running" ? <Spinner aria-hidden /> : null}
          <button
            type="button"
            className="studio-icon-button nodrag"
            aria-label={t("Remove node")}
            onClick={() => onRemove(wfNode.id)}
          >
            <IconCrossSmall size={14} />
          </button>
        </span>
      </div>
      {inputs.length > 0 ? (
        <div className="studio-node-ports">
          {inputs.map((port) => (
            <div key={port.id} className="studio-node-port">
              <Handle type="target" position={Position.Left} id={port.id} />
              <span className="studio-node-port-label">{port.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      {inputs
        .filter((port) => port.multi && (data.portSources?.[port.id]?.length ?? 0) > 1)
        .map((port) => {
          const sources = data.portSources?.[port.id] ?? [];
          // Image inputs of a prompted node can be talked about by position:
          // clicking an entry drops the mention into the prompt, spelled the
          // way the target model reads it (seedance wants `<Image 1>`, and
          // gets the wrong workflow when handed plain prose).
          const mentionable =
            port.kind === "image" && schema.params.some((param) => param.name === "prompt");
          const modelId = typeof wfNode.params.model === "string" ? wfNode.params.model : "";
          // Kling names a reference by what it shows (a character's angles
          // share `@Element1`, a place is an `@Image`), which the film
          // compiler recorded per artifact; every other family counts.
          const knownRoles = wfNode.params.referenceRoles as
            | Record<string, ReferenceRole | undefined>
            | undefined;
          const mentions = referenceMentions(
            modelId ? { id: modelId } : undefined,
            sources.length,
            sources.map((source) =>
              source.artifactId && knownRoles && typeof knownRoles === "object"
                ? knownRoles[source.artifactId]
                : undefined,
            ),
          );
          const mentionFor = (index: number) => mentions[index] ?? "";
          return (
            <div key={port.id} className="studio-port-order nodrag">
              <span className="studio-port-order-head">
                {t("{label} order", { label: port.label })}
              </span>
              <ol className="studio-port-order-list">
                {sources.map((source, index) => (
                  <li
                    key={source.edgeId}
                    onMouseEnter={() => data.onHighlightEdge?.(source.edgeId)}
                    onMouseLeave={() => data.onHighlightEdge?.(undefined)}
                    onFocus={() => data.onHighlightEdge?.(source.edgeId)}
                    onBlur={() => data.onHighlightEdge?.(undefined)}
                  >
                    <button
                      type="button"
                      className="studio-port-order-entry"
                      disabled={!mentionable || !mentionFor(index)}
                      title={
                        mentionable && mentionFor(index)
                          ? t('Add "{name}" to the prompt', { name: mentionFor(index) })
                          : undefined
                      }
                      onClick={() => {
                        const prompt =
                          typeof wfNode.params.prompt === "string" ? wfNode.params.prompt : "";
                        const mention = mentionFor(index);
                        onParamsChange(wfNode.id, {
                          ...wfNode.params,
                          prompt: prompt ? `${prompt.trimEnd()} ${mention}` : mention,
                        });
                      }}
                    >
                      <span className="studio-port-order-index">{index + 1}</span>
                      {source.image ? <img src={source.image} alt="" /> : null}
                      <span className="studio-port-order-label">{source.label}</span>
                    </button>
                    <span className="studio-port-order-actions">
                      <button
                        type="button"
                        className="studio-icon-button"
                        aria-label={t("Move {name} up", { name: source.label })}
                        disabled={index === 0}
                        onClick={() => data.onReorderEdge?.(source.edgeId, -1)}
                      >
                        <IconArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        className="studio-icon-button"
                        aria-label={t("Move {name} down", { name: source.label })}
                        disabled={index === sources.length - 1}
                        onClick={() => data.onReorderEdge?.(source.edgeId, 1)}
                      >
                        <IconArrowDown size={12} />
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
              {wfNode.type === "assemble" && port.id === "clips" && data.chainSuggestion ? (
                <button
                  type="button"
                  className="btn btn-secondary studio-port-order-chain"
                  title={t("These clips continue each other; cut them in chain order.")}
                  onClick={() => data.onApplyChainOrder?.(wfNode.id, data.chainSuggestion ?? [])}
                >
                  {t("Order by chain")}
                </button>
              ) : null}
            </div>
          );
        })}
      {schema.params
        // A setting the chosen model does not have is not shown: an
        // image-to-video model takes its frame from the source image and has
        // no aspect ratio, and a box for one could only fail the render.
        .filter((param) => paramApplies(param, wfNode.params, catalog))
        .map((param) => (
          <ParamField
            key={param.name}
            node={wfNode}
            param={param}
            catalog={catalog}
            artifacts={data.artifacts}
            textSources={data.textSources ?? []}
            constraintEpoch={data.constraintEpoch}
            onMerge={(partial) => onParamsChange(wfNode.id, { ...wfNode.params, ...partial })}
          />
        ))}
      {result?.status === "awaiting" ? <GateApproval data={data} /> : null}
      {result ? <NodeOutputView result={result} node={wfNode} /> : null}
      {schema.output !== "none" ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

export const NODE_TYPES = { studio: StudioNode };
