// The canvas node: header, ports, settings, ordering lists, the gate's
// approval controls and the node's output.

import { t } from "../../../lib/i18n";
import { Handle, Position, type NodeProps, useStore } from "@xyflow/react";
import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconChevronRight } from "central-icons/IconChevronRight";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconPlay } from "central-icons/IconPlay";
import { useState } from "react";
import { formatCredits } from "../../../lib/studio/catalog";
import type { ReferenceRole } from "../../../lib/studio/kling";
import { referenceMentions } from "../../../lib/studio/seedance";
import {
  estimateNodeCost,
  isPaidNode,
  nodeLabel,
  paramApplies,
  nodeSchema,
  openInputPorts,
} from "../../../lib/studio/workflow";
import { nodeTypeLabel, portLabel } from "../../../lib/studio/workflow/labels";
import type { NodeMode } from "../../../lib/studio/workflow/modes";
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

/** Below this zoom a step is drawn as its name and state only. */
const COMPACT_BELOW_ZOOM = 0.5;

/** Steps with nothing upstream to run: running one alone is just reading. */
const SOURCES = new Set(["textInput", "asset", "document"]);

export function StudioNode({ data }: NodeProps<StudioFlowNode>) {
  const { wfNode, catalog, result, onParamsChange, onRemove } = data;
  const schema = nodeSchema(wfNode.type);
  // The inputs this node carries: its model can close some of them, and a
  // port that is not drawn is a port nothing can be wired to.
  const inputs = openInputPorts(schema, wfNode.params);
  const cost = data.price ?? estimateNodeCost(wfNode, catalog);
  // A paid step that has something to reuse can be asked for a new take:
  // the counter is part of what the step asks, so the next run misses the
  // cache for it (and for what it feeds) and makes a new one.
  const canMakeAgain =
    isPaidNode(wfNode) &&
    wfNode.type !== "gate" &&
    wfNode.params.freshEachRun !== true &&
    result?.status !== "running" &&
    (result?.status === "done" || data.willReuse === true);
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
  // Far out, a step is its name and its state: drawing every field of a
  // graph of a hundred steps is what makes zooming out stutter.
  const zoom = useStore((state) => state.transform[2]);
  if (wfNode.type === "relay") {
    return (
      <div className="studio-relay" data-run={runState} title={t("Relay")}>
        <Handle type="target" position={Position.Left} id="in" />
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }
  if (wfNode.collapsed || zoom < COMPACT_BELOW_ZOOM) {
    const picture = result?.output?.kind === "image" ? result.output : undefined;
    return (
      <div
        className="studio-node studio-node-compact"
        data-run={runState}
        data-mode={wfNode.mode}
        data-color={wfNode.color}
        data-will-pay={data.willPay ? "true" : undefined}
      >
        {/* Every input keeps its handle, so the wires stay attached. */}
        {inputs.map((port) => (
          <Handle key={port.id} type="target" position={Position.Left} id={port.id} />
        ))}
        <div className="studio-node-compact-title">
          {wfNode.collapsed ? (
            <button
              type="button"
              className="studio-icon-button nodrag"
              aria-label={t("Expand")}
              onClick={() => data.onLayoutChange?.(wfNode.id, { collapsed: false })}
            >
              <IconChevronRight size={14} />
            </button>
          ) : null}
          <span>{nodeLabel(wfNode)}</span>
          {result?.status === "running" ? <Spinner aria-hidden /> : null}
        </div>
        {picture ? (
          <img
            className="studio-node-compact-picture"
            alt=""
            src={`data:${picture.mimeType};base64,${picture.base64}`}
          />
        ) : null}
        {schema.output !== "none" ? <Handle type="source" position={Position.Right} /> : null}
      </div>
    );
  }
  return (
    <div
      className="studio-node"
      data-run={runState}
      data-invalid={data.issues?.some((issue) => issue.severity === "error") ? "true" : undefined}
      data-mode={wfNode.mode}
      data-color={wfNode.color}
      data-will-pay={data.willPay ? "true" : undefined}
    >
      <div className="studio-node-head">
        {/* The name is the node's own, and its type stands in as the
            placeholder until it has one: three asset nodes all reading
            "Asset" is exactly what naming them is for, and the connection
            lists, the gate candidates and the cost breakdown all read it. */}
        <input
          className="studio-node-title nodrag"
          value={wfNode.label}
          placeholder={nodeTypeLabel(wfNode.type)}
          aria-label={t("{type} name", { type: nodeTypeLabel(wfNode.type) })}
          onChange={(event) => data.onRename(wfNode.id, event.target.value)}
        />
        <span className="studio-card-actions">
          {result?.status === "running" && typeof result.progress === "number" ? (
            <span className="studio-node-kind">{Math.round(result.progress * 100)}%</span>
          ) : null}
          {result?.status === "running" ? <Spinner aria-hidden /> : null}
          {canMakeAgain ? (
            <button
              type="button"
              className="studio-icon-button nodrag"
              aria-label={t("Make a new one next run")}
              title={t("Make a new one next run")}
              onClick={() =>
                onParamsChange(wfNode.id, {
                  ...wfNode.params,
                  take: (typeof wfNode.params.take === "number" ? wfNode.params.take : 0) + 1,
                })
              }
            >
              <IconArrowRotateClockwise size={14} />
            </button>
          ) : null}
          {data.onRunStep && result?.status !== "running" && !SOURCES.has(wfNode.type) ? (
            <button
              type="button"
              className="studio-icon-button nodrag"
              aria-label={t("Run this step")}
              title={t("Run this step and what it needs, nothing else")}
              onClick={() => data.onRunStep?.(wfNode.id)}
            >
              <IconPlay size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="studio-icon-button nodrag"
            aria-label={t("Collapse")}
            title={t("Collapse")}
            onClick={() => data.onLayoutChange?.(wfNode.id, { collapsed: true })}
          >
            <IconChevronDownSmall size={14} />
          </button>
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
      {/* The second line says what the step is and what it costs, and how it
          runs: the title keeps the whole width of the first. */}
      <div className="studio-node-meta">
        {wfNode.label.trim() ? (
          // Named, so the type no longer shows in the title. Keep it legible.
          <span className="studio-node-kind">{nodeTypeLabel(wfNode.type)}</span>
        ) : null}
        {result?.reused ? (
          <span className="studio-node-reused" title={t("Same request as before, nothing spent.")}>
            {t("Reused")}
          </span>
        ) : data.willReuse && result?.status !== "running" ? (
          <span
            className="studio-node-reused"
            title={t("Unchanged since it was made: the next run reuses it for free.")}
          >
            {t("Free")}
          </span>
        ) : cost.kind === "flat" && cost.credits !== undefined && cost.credits > 0 ? (
          <span className="studio-node-kind">~{formatCredits(cost.credits)}</span>
        ) : cost.kind === "metered" ? (
          <span className="studio-node-kind" title={t("Billed by what it uses")}>
            {t("usage")}
          </span>
        ) : null}
        {data.onModeChange ? (
          <select
            className="studio-node-mode nodrag"
            aria-label={t("Runs")}
            title={t("Skipped passes its input on; off also stops what cannot run without it.")}
            value={wfNode.mode ?? "always"}
            onChange={(event) =>
              data.onModeChange?.(
                wfNode.id,
                event.target.value === "always" ? undefined : (event.target.value as NodeMode),
              )
            }
          >
            <option value="always">{t("Always")}</option>
            <option value="bypass">{t("Skipped")}</option>
            <option value="mute">{t("Off")}</option>
          </select>
        ) : null}
      </div>
      {data.issues?.length ? (
        <ul className="studio-node-issues">
          {data.issues.map((issue) => (
            <li
              key={`${issue.code ?? ""}:${issue.port ?? ""}:${issue.message}`}
              data-severity={issue.severity}
            >
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {inputs.length > 0 ? (
        <div className="studio-node-ports">
          {inputs.map((port) => (
            <div key={port.id} className="studio-node-port">
              <Handle type="target" position={Position.Left} id={port.id} />
              <span className="studio-node-port-label">{portLabel(wfNode.type, port)}</span>
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
                {t("{label} order", { label: portLabel(wfNode.type, port) })}
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
