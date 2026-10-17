// Making a workflow an app (ADR-0119), in three steps on one sheet: what a
// person fills in, what they get, and in what order the fields come. It
// starts from a suggestion for a workflow that has no app yet; nothing is
// kept until the person keeps it.

import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { useState } from "react";
import { t } from "../../../lib/i18n";
import type { MediaCatalog } from "../../../lib/studio/types";
import {
  exposableParams,
  moveField,
  resultSteps,
  shownFields,
  suggestApp,
  toggleField,
  toggleOutput,
  type WorkflowApp,
} from "../../../lib/studio/workflow/app";
import { nodeTypeLabel, paramLabel } from "../../../lib/studio/workflow/labels";
import type { Workflow } from "../../../lib/studio/workflow/schema";
import { Dialog } from "../../ui/Dialog";

export function AppBuilder({
  workflow,
  catalog,
  onKeep,
  onClose,
}: {
  workflow: Workflow;
  catalog: MediaCatalog;
  /** The app to keep, or undefined to make the workflow a graph again. */
  onKeep: (app: WorkflowApp | undefined) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<WorkflowApp>(() => workflow.app ?? suggestApp(workflow));
  const stepName = (node: Workflow["nodes"][number]) => node.label || nodeTypeLabel(node.type);
  const steps = workflow.nodes
    .map((node) => ({ node, params: exposableParams(node, catalog) }))
    .filter((entry) => entry.params.length > 0);
  const chosen = shownFields(draft, workflow, catalog);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("Make this workflow an app")}
      description={t(
        "An app shows a few settings and results, and runs the whole workflow. The graph stays as it is.",
      )}
      width={640}
      footer={
        <>
          {workflow.app ? (
            <button type="button" className="btn btn-secondary" onClick={() => onKeep(undefined)}>
              {t("Remove the app")}
            </button>
          ) : null}
          <span className="studio-spacer" />
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="studio-primary-button"
            disabled={draft.fields.length === 0 && draft.outputs.length === 0}
            onClick={() => onKeep(draft)}
          >
            {t("Keep this app")}
          </button>
        </>
      }
    >
      <div className="dialog-body app-builder">
        <label className="app-builder-intro">
          <span>{t("What the app is for")}</span>
          <textarea
            className="studio-input"
            rows={2}
            value={draft.intro ?? ""}
            placeholder={t("One sentence above the form")}
            onChange={(event) => setDraft({ ...draft, intro: event.target.value })}
          />
        </label>
        <section aria-label={t("What a person fills in")}>
          <h3>{t("1. What a person fills in")}</h3>
          {steps.map(({ node, params }) => (
            <fieldset key={node.id} className="app-builder-step">
              <legend>{stepName(node)}</legend>
              {params.map((param) => (
                <label key={param.name} className="app-builder-choice">
                  <input
                    type="checkbox"
                    checked={draft.fields.some(
                      (field) => field.nodeId === node.id && field.param === param.name,
                    )}
                    onChange={() => setDraft(toggleField(draft, node.id, param.name))}
                  />
                  {paramLabel(param)}
                </label>
              ))}
            </fieldset>
          ))}
        </section>
        <section aria-label={t("What they get")}>
          <h3>{t("2. What they get")}</h3>
          <div className="app-builder-outputs">
            {resultSteps(workflow).map((node) => (
              <label key={node.id} className="app-builder-choice">
                <input
                  type="checkbox"
                  checked={draft.outputs.includes(node.id)}
                  onChange={() => setDraft(toggleOutput(draft, node.id))}
                />
                {stepName(node)}
              </label>
            ))}
          </div>
        </section>
        <section aria-label={t("In what order")}>
          <h3>{t("3. In what order")}</h3>
          {chosen.length === 0 ? (
            <p className="app-builder-hint">{t("Choose a setting above to order it here.")}</p>
          ) : (
            <ol className="app-builder-order">
              {chosen.map(({ field, node, param }, index) => (
                <li key={`${node.id}:${param.name}`}>
                  <input
                    className="studio-input"
                    aria-label={t("Name of {setting}", { setting: paramLabel(param) })}
                    value={field.label ?? ""}
                    placeholder={`${stepName(node)} · ${paramLabel(param)}`}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        fields: draft.fields.map((entry) =>
                          entry === field ? { ...entry, label: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="studio-icon-button"
                    aria-label={t("Move {setting} up", { setting: paramLabel(param) })}
                    disabled={index === 0}
                    onClick={() => setDraft(moveField(draft, draft.fields.indexOf(field), -1))}
                  >
                    <IconArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="studio-icon-button"
                    aria-label={t("Move {setting} down", { setting: paramLabel(param) })}
                    disabled={index === chosen.length - 1}
                    onClick={() => setDraft(moveField(draft, draft.fields.indexOf(field), 1))}
                  >
                    <IconArrowDown size={14} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Dialog>
  );
}
