// Whether a library copy is still the template it was started from
// (sameTemplateCopy): the phone reopens that copy instead of saving another.

import { describe, expect, it } from "vitest";
import { sameTemplateCopy } from "../lib/studio/workflow/library";
import { blankWorkflow } from "../lib/studio/workflow/store";
import { copyTemplate, templateWorkflows } from "../lib/studio/workflow/templates";

const template = () => {
  const found = templateWorkflows().find((entry) => entry.id === "template-album-cover");
  if (!found) throw new Error("template");
  return found;
};

describe("a copy of a shipped app", () => {
  it("is the template, fresh ids and all", () => {
    const copy = copyTemplate(template(), blankWorkflow("Album cover"));
    expect(copy.nodes[0].id).not.toBe(template().nodes[0].id);
    expect(sameTemplateCopy(copy, template())).toBe(true);
  });

  it("is still the template once its form is filled in", () => {
    const copy = copyTemplate(template(), blankWorkflow("Album cover"));
    const field = copy.app?.fields[0];
    if (!field) throw new Error("field");
    const filled = {
      ...copy,
      nodes: copy.nodes.map((node) =>
        node.id === field.nodeId
          ? { ...node, params: { ...node.params, [field.param]: "A night drive" } }
          : node,
      ),
    };
    expect(sameTemplateCopy(filled, template())).toBe(true);
  });

  it("is something else once a step is added or a hidden setting changed", () => {
    const copy = copyTemplate(template(), blankWorkflow("Album cover"));
    const grown = {
      ...copy,
      nodes: [
        ...copy.nodes,
        {
          id: "x",
          type: "note" as const,
          label: "",
          position: { x: 0, y: 0 },
          params: { text: "Hi" },
        },
      ],
    };
    expect(sameTemplateCopy(grown, template())).toBe(false);
    const image = copy.nodes.find((node) => node.type === "image");
    if (!image) throw new Error("image step");
    const retuned = {
      ...copy,
      nodes: copy.nodes.map((node) =>
        node.id === image.id ? { ...node, params: { ...node.params, model: "other-model" } } : node,
      ),
    };
    expect(sameTemplateCopy(retuned, template())).toBe(false);
  });
});
