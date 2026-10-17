// The steps a workflow can hold, reduced to what an assistant needs to wire
// a proposal (ADR-0120): each step's inputs, what it gives and its settings.
// Written to step-catalog.json, which the native side embeds to check a
// proposal and to answer the assistant; a test keeps the two equal.

import { NODE_SCHEMAS, type WorkflowNodeType } from "./schema";

/** Steps the app makes for itself and an assistant never draws. */
const INTERNAL = new Set<WorkflowNodeType>(["block", "listItem"]);

export interface CatalogStep {
  type: string;
  label: string;
  description: string;
  inputs: Array<{ id: string; kind: string; multi?: true }>;
  output: string;
  params: Array<{ name: string; type: string; values?: string[] }>;
  paid?: true;
}

export function stepCatalog(): CatalogStep[] {
  return Object.values(NODE_SCHEMAS)
    .filter((schema) => !INTERNAL.has(schema.type))
    .map((schema) => ({
      type: schema.type,
      label: schema.label,
      description: schema.description,
      inputs: schema.inputs.map((input) => ({
        id: input.id,
        kind: input.kind,
        ...(input.multi ? { multi: true as const } : {}),
      })),
      output: schema.output,
      params: schema.params.map((param) => ({
        name: param.name,
        type: param.type,
        ...(param.enumValues?.length ? { values: [...param.enumValues] } : {}),
      })),
      ...(schema.paid ? { paid: true as const } : {}),
    }));
}
