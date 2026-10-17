// Bringing an older workflow forward: a node type that was renamed becomes
// its successor, and a node saved under an older schema version has its
// settings reshaped step by step. The ComfyUI `NodeReplace` idea, at the
// scale of this app.
//
// Applied when a workflow is opened and when a file is imported, never to a
// run: a run executes the graph frozen when it started (ADR-0021), and
// moving ids or ports under its node rows would corrupt the resume.

import { maybeNodeSchema, type Workflow, type WorkflowNode, type WorkflowNodeType } from "./schema";

/** A node type that no longer exists, and what it became. */
export interface NodeReplacement {
  from: string;
  to: WorkflowNodeType;
  /** Settings renamed or fixed on the way; the rest carry over. */
  params?: (params: Record<string, unknown>) => Record<string, unknown>;
}

/** One step of a node type's settings, from one schema version to the next. */
export interface NodeMigration {
  type: WorkflowNodeType;
  /** The version this step reads; it writes `from + 1`. */
  from: number;
  params: (params: Record<string, unknown>) => Record<string, unknown>;
}

export interface MigrationRegistry {
  replacements: readonly NodeReplacement[];
  migrations: readonly NodeMigration[];
  /** Target versions that differ from the schemas' own (tests stand a node
   * type up at a later version without changing the real schema). */
  versions?: Partial<Record<WorkflowNodeType, number>>;
}

/** Nothing has been renamed or reshaped yet; the first change adds its step
 * here, with a test that opens a node saved before it. */
export const MIGRATIONS: MigrationRegistry = { replacements: [], migrations: [] };

function migrateNode(node: WorkflowNode, registry: MigrationRegistry): WorkflowNode {
  let current = node;
  const replacement = maybeNodeSchema(current.type)
    ? undefined
    : registry.replacements.find((entry) => entry.from === current.type);
  if (replacement) {
    current = {
      ...current,
      type: replacement.to,
      params: replacement.params ? replacement.params(current.params) : current.params,
      v: undefined,
    };
  }
  const target = registry.versions?.[current.type] ?? maybeNodeSchema(current.type)?.version ?? 1;
  let version = current.v ?? 1;
  while (version < target) {
    const step = registry.migrations.find(
      (entry) => entry.type === current.type && entry.from === version,
    );
    // A missing step leaves the node as it is rather than guessing; the
    // validator says what it cannot read.
    if (!step) break;
    current = { ...current, params: step.params(current.params) };
    version += 1;
  }
  const { v: _saved, ...rest } = current;
  return version > 1 ? { ...rest, v: version } : rest;
}

/** The workflow with every node brought forward. Returns the same object when
 * nothing needed to change, so opening a workflow is not mistaken for an
 * edit. */
export function migrateWorkflow<W extends Pick<Workflow, "nodes">>(
  workflow: W,
  registry: MigrationRegistry = MIGRATIONS,
): W {
  let changed = false;
  const nodes = workflow.nodes.map((node) => {
    const migrated = migrateNode(node, registry);
    if (JSON.stringify(migrated) === JSON.stringify(node)) return node;
    changed = true;
    return migrated;
  });
  return changed ? { ...workflow, nodes } : workflow;
}
