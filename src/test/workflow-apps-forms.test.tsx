// Every shipped app drawn by both shells, filled in: each field has its
// labelled control, the run button is live and priced, and one place is set
// for each result. Then the two retouch apps, empty: the blocker names the
// picture and the button waits. The invariants themselves are judged without
// a DOM in workflow-apps-matrix.test.ts; this only proves the forms draw them.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppRunScreen } from "../components/mobile/screens/studio/AppRunScreen";
import { costSummary } from "../components/studio/workflow/RunCostDialog";
import { WorkflowAppView } from "../components/studio/workflow/WorkflowAppView";
import type { StudioArtifact } from "../lib/studio/types";
import { isApp, shownFields } from "../lib/studio/workflow/app";
import { appEstimate, appGraph } from "../lib/studio/workflow/app-run";
import { nodeTypeLabel, paramLabel } from "../lib/studio/workflow/labels";
import type { Workflow } from "../lib/studio/workflow/schema";
import { templateWorkflows } from "../lib/studio/workflow/templates";
import { validateWorkflow } from "../lib/studio/workflow/validator";
import { catalogFor, filledApp, STAND_INS } from "./workflow-apps-fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    if (command === "carpe_diem_media_list_artifacts")
      return [
        { path: "/g/hero.png", fileName: "hero.png", bytes: 10, modifiedMs: 1 },
        { path: "/g/clip.mp4", fileName: "clip.mp4", bytes: 10, modifiedMs: 2 },
        { path: "/g/theme.mp3", fileName: "theme.mp3", bytes: 10, modifiedMs: 3 },
      ];
    if (command === "studio_artifact_save")
      return { id: (args as { request: { id: string } }).request.id };
    if (command === "studio_workflow_list" || command === "workflow_run_history") return [];
    if (command === "workflow_cache_known") return [];
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const templates = templateWorkflows();
const catalog = catalogFor(templates);
const apps = templates.filter(isApp);

const artifact = (id: string, kind: StudioArtifact["kind"]): StudioArtifact => ({
  id,
  kind,
  path: `/g/${id}`,
  fileName: id,
  bytes: 10,
  model: "",
  prompt: "",
  createdAt: 1,
});
const artifacts = {
  byId: new Map([
    [STAND_INS.image.id, artifact(STAND_INS.image.id, "image")],
    [STAND_INS.video.id, artifact(STAND_INS.video.id, "video")],
    [STAND_INS.audio.id, artifact(STAND_INS.audio.id, "music")],
  ]),
  loaded: true,
  remember: vi.fn(),
};

function desktop(workflow: Workflow) {
  const graph = appGraph(workflow);
  return render(
    <WorkflowAppView
      workflow={workflow}
      catalog={catalog}
      artifacts={artifacts}
      results={new Map()}
      constraintEpoch={0}
      onParamsChange={vi.fn()}
      estimate={appEstimate(graph, catalog)}
      run={{
        running: false,
        onStop: vi.fn(),
        canRun: validateWorkflow(graph.effective).ok,
        readOnly: false,
        runIssues: undefined,
        quoting: false,
        onRun: vi.fn(),
      }}
      onBuild={vi.fn()}
    />,
  );
}

const fieldLabel = ({ field, node }: ReturnType<typeof shownFields>[number]) =>
  field.label || node.label || nodeTypeLabel(node.type);

describe.each(apps.map((app) => [app.id, app] as const))("the app %s", (_id, template) => {
  const full = filledApp(template, catalog);
  const fields = shownFields(full.app, full, catalog);
  const outputs = full.app?.outputs ?? [];
  const price = costSummary(appEstimate(appGraph(full), catalog));

  it("draws on the phone with every field, a priced run and a place for each result", () => {
    const { container, unmount } = render(<AppRunScreen workflow={full} catalog={catalog} />);
    for (const shown of fields) {
      const label = fieldLabel(shown);
      // A control named by the field: a text box, a toggle, a sheet row, or
      // the picture's button under its heading.
      const control =
        screen.queryAllByRole("textbox", { name: label })[0] ??
        screen.queryAllByRole("spinbutton", { name: label })[0] ??
        screen.queryAllByRole("switch", { name: label })[0] ??
        screen.queryAllByRole("button", { name: new RegExp(`^${literal(label)}, `) })[0] ??
        (screen.queryAllByText(label).length > 0
          ? screen.queryAllByRole("button", { name: /Choose (a|another) picture/ })[0]
          : undefined);
      expect([template.id, label, Boolean(control)]).toEqual([template.id, label, true]);
    }
    const run = screen.getByRole("button", { name: /^Run, / });
    expect(run).toBeEnabled();
    expect(run.textContent).toContain(price);
    expect(container.querySelectorAll(".mobile-app-result figcaption")).toHaveLength(
      outputs.length,
    );
    unmount();
  });

  it("draws on the desktop with every field, the price and a place for each result", () => {
    const { container, unmount } = desktop(full);
    const boxes = [...container.querySelectorAll<HTMLElement>(".workflow-app-field")];
    expect(boxes.map((box) => box.querySelector(".workflow-app-step")?.textContent)).toEqual(
      fields.map(fieldLabel),
    );
    fields.forEach((shown, index) => {
      const box = within(boxes[index]);
      // A gallery item is a picker button; every other setting is labelled
      // by the step's own setting name, not the field's (a conscious
      // difference from the phone).
      const control =
        shown.param.type === "artifact"
          ? boxes[index].querySelector("button.studio-node-picker")
          : box.queryAllByLabelText(paramLabel(shown.param))[0];
      expect([template.id, shown.field.param, Boolean(control)]).toEqual([
        template.id,
        shown.field.param,
        true,
      ]);
    });
    expect(container.querySelector(".studio-workflow-cost")?.textContent).toBe(price);
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeEnabled();
    expect(container.querySelectorAll(".workflow-app-result figcaption")).toHaveLength(
      outputs.length,
    );
    unmount();
  });
});

describe("an app whose picture is still to pick", () => {
  const empty = templates.find((entry) => entry.id === "template-before-and-after") as Workflow;

  it("says which field waits and holds the run, on the phone", () => {
    render(<AppRunScreen workflow={empty} catalog={catalog} />);
    expect(screen.getByText("The picture: pick a picture.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Run/ })).toBeDisabled();
  });

  it("says which field waits and holds the run, on the desktop", () => {
    const { container } = desktop(empty);
    expect(
      within(container as HTMLElement).getByText("The picture: pick a picture."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeDisabled();
  });
});

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
