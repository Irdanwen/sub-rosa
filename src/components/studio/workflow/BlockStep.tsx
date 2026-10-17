// A block step on the canvas (ADR-0116): its name, its inputs and outputs
// (each an inner step's own), the settings its block promotes, and what it
// made. It runs as its steps; their state, price and problems are lifted
// onto it (lift.ts).

import { Handle, Position } from "@xyflow/react";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconPackage } from "central-icons/IconPackage";
import { IconPlay } from "central-icons/IconPlay";
import { formatCredits } from "../../../lib/studio/catalog";
import { t } from "../../../lib/i18n";
import {
  blockOf,
  blockPorts,
  instanceParams,
  settingKey,
  settingsOf,
} from "../../../lib/studio/workflow/blocks";
import { maybeNodeSchema } from "../../../lib/studio/workflow";
import type { NodeMode } from "../../../lib/studio/workflow/modes";
import { Spinner } from "../../ui/Spinner";
import type { StudioNodeData } from "./flow";
import { NodeOutputView } from "./NodeOutputView";
import { ParamField } from "./ParamField";

export function BlockStep({ data, compact }: { data: StudioNodeData; compact: boolean }) {
  const { wfNode, result } = data;
  const block = blockOf(wfNode, data.blocks);
  const ports = block ? blockPorts(block, data.blocks) : { inputs: [], outputs: [] };
  const name = wfNode.label.trim() || block?.name || t("Block");
  const runState = result?.status === "pending" ? undefined : result?.status;
  const settings = settingsOf(wfNode);
  const handles = (
    <>
      {ports.inputs.map((port) => (
        <Handle key={port.id} type="target" position={Position.Left} id={port.id} />
      ))}
    </>
  );
  const outputs = ports.outputs.map((port) => (
    <div key={port.id} className="studio-block-output">
      <span className="studio-node-port-label">{port.label}</span>
      <Handle type="source" position={Position.Right} id={port.id} />
    </div>
  ));
  if (compact) {
    return (
      <div
        className="studio-node studio-node-compact studio-block"
        data-type="block"
        data-run={runState}
        data-mode={wfNode.mode}
        data-color={wfNode.color}
      >
        {handles}
        <div className="studio-node-compact-title">
          <IconPackage size={14} aria-hidden />
          <span>{name}</span>
          {result?.status === "running" ? <Spinner aria-hidden /> : null}
        </div>
        {outputs}
      </div>
    );
  }
  const price = data.price;
  return (
    <div
      className="studio-node studio-block"
      data-type="block"
      data-run={runState}
      data-invalid={data.issues?.some((issue) => issue.severity === "error") ? "true" : undefined}
      data-mode={wfNode.mode}
      data-color={wfNode.color}
      data-will-pay={data.willPay ? "true" : undefined}
    >
      <div className="studio-node-head">
        <input
          className="studio-node-title nodrag"
          value={wfNode.label}
          placeholder={block?.name || t("Block")}
          aria-label={t("Block name")}
          onChange={(event) => data.onRename(wfNode.id, event.target.value)}
        />
        <span className="studio-card-actions">
          {result?.status === "running" && typeof result.progress === "number" ? (
            <span className="studio-node-kind">{Math.round(result.progress * 100)}%</span>
          ) : null}
          {result?.status === "running" ? <Spinner aria-hidden /> : null}
          {data.onRunStep && block && result?.status !== "running" ? (
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
          {block && data.onUngroup ? (
            <button
              type="button"
              className="studio-icon-button nodrag"
              aria-label={t("Ungroup")}
              title={t("Put its steps back in its place")}
              onClick={() => data.onUngroup?.(wfNode.id)}
            >
              <IconPackage size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="studio-icon-button nodrag"
            aria-label={t("Remove node")}
            onClick={() => data.onRemove(wfNode.id)}
          >
            <IconCrossSmall size={14} />
          </button>
        </span>
      </div>
      <div className="studio-node-meta">
        <span className="studio-node-kind">
          {!block
            ? t("Block")
            : block.nodes.length === 1
              ? t("Block of one step")
              : t("Block of {count} steps", { count: block.nodes.length })}
        </span>
        {price?.reused ? (
          <span className="studio-node-reused" title={t("Same request as before, nothing spent.")}>
            {t("Free")}
          </span>
        ) : price?.kind === "flat" && price.credits !== undefined && price.credits > 0 ? (
          <span className="studio-node-kind">~{formatCredits(price.credits)}</span>
        ) : price?.kind === "metered" ? (
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
              key={`${issue.nodeId ?? ""}:${issue.code ?? ""}:${issue.port ?? ""}:${issue.message}`}
              data-severity={issue.severity}
            >
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {ports.inputs.length > 0 ? (
        <div className="studio-node-ports">
          {ports.inputs.map((port) => (
            <div key={port.id} className="studio-node-port">
              <Handle type="target" position={Position.Left} id={port.id} />
              <span className="studio-node-port-label">{port.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      {block
        ? block.promoted.map((setting) => {
            const inner = block.nodes.find((entry) => entry.id === setting.nodeId);
            const param = inner
              ? maybeNodeSchema(inner.type)?.params.find((entry) => entry.name === setting.param)
              : undefined;
            if (!inner || !param) return null;
            const node = { ...inner, params: instanceParams(block, inner, settings) };
            return (
              <div key={settingKey(setting)} className="studio-block-setting">
                {setting.label ? (
                  <span className="studio-node-port-label">{setting.label}</span>
                ) : null}
                <ParamField
                  node={node}
                  param={param}
                  catalog={data.catalog}
                  artifacts={data.artifacts}
                  textSources={[]}
                  constraintEpoch={data.constraintEpoch}
                  onMerge={(partial) => {
                    const next = { ...settings };
                    for (const [name, value] of Object.entries(partial))
                      next[settingKey({ nodeId: inner.id, param: name })] = value;
                    data.onParamsChange(wfNode.id, { ...wfNode.params, settings: next });
                  }}
                />
              </div>
            );
          })
        : null}
      {result?.output || result?.status === "running" || result?.status === "error" ? (
        <NodeOutputView result={result} node={wfNode} />
      ) : null}
      {outputs.length > 0 ? <div className="studio-block-outputs">{outputs}</div> : null}
    </div>
  );
}
