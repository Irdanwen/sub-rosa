// Finding a step to add by typing (ComfyUI's node search): every step type
// by its translated name and a few words, grouped by what it is for, and,
// when a connection is being dragged, only the steps that can take it (or
// feed it).

import { t } from "../../i18n";
import { nodeTypeLabel } from "./labels";
import {
  defaultParams,
  type IOKind,
  isIdealMatch,
  isInputCompatible,
  NODE_SCHEMAS,
  openInputPorts,
  type PortKind,
  type WorkflowNodeType,
} from "./schema";

export type NodeCategory = "inputs" | "generate" | "montage" | "flow" | "blocks";

const CATEGORY: Record<WorkflowNodeType, NodeCategory> = {
  textInput: "inputs",
  asset: "inputs",
  document: "inputs",
  chat: "generate",
  image: "generate",
  imageEdit: "generate",
  tts: "generate",
  music: "generate",
  video: "generate",
  lastFrame: "montage",
  assemble: "montage",
  gate: "flow",
  output: "flow",
  relay: "flow",
  note: "flow",
  block: "flow",
  upscale: "generate",
  cutout: "generate",
  soundMix: "montage",
  compare: "flow",
  zoneEdit: "generate",
  sheet: "generate",
  textTemplate: "inputs",
  preview: "flow",
  switch: "flow",
  textList: "inputs",
  splitText: "flow",
  imageList: "inputs",
  listItem: "flow",
};

export function categoryLabel(category: NodeCategory): string {
  switch (category) {
    case "inputs":
      return t("Inputs");
    case "generate":
      return t("Generate");
    case "montage":
      return t("Montage");
    case "flow":
      return t("Flow");
    case "blocks":
      return t("Blocks");
  }
}

/** Extra words each type is found by, in the reader's language. */
function keywords(type: WorkflowNodeType): string {
  switch (type) {
    case "textInput":
      return t("text prompt words");
    case "asset":
      return t("gallery picture clip sound file");
    case "document":
      return t("note document text");
    case "chat":
      return t("write rewrite text model llm");
    case "image":
      return t("picture photo generate");
    case "imageEdit":
      return t("retouch edit combine picture");
    case "tts":
      return t("voice speech read aloud");
    case "music":
      return t("song score soundtrack sound effect");
    case "video":
      return t("clip shot film animate");
    case "lastFrame":
      return t("frame still handoff");
    case "assemble":
      return t("cut montage film join");
    case "gate":
      return t("approve choose judge pause");
    case "output":
      return t("result end");
    case "relay":
      return t("reroute point route wire");
    case "note":
      return t("comment text explain");
    case "block":
      return t("group subgraph several steps");
    case "upscale":
      return t("enlarge sharpen resolution bigger");
    case "cutout":
      return t("remove background transparent subject");
    case "soundMix":
      return t("mix voice music audio duck");
    case "compare":
      return t("before after slider side by side");
    case "zoneEdit":
      return t("inpaint region area fix part retouch mask");
    case "sheet":
      return t("grid nine angles expressions variations composer");
    case "textTemplate":
      return t("template fill blanks join combine words");
    case "preview":
      return t("show look view display");
    case "switch":
      return t("if condition choose either branch toggle");
    case "textList":
      return t("list batch several many each lines");
    case "splitText":
      return t("split lines list batch each");
    case "imageList":
      return t("pictures batch several many each gallery");
    case "listItem":
      return "";
  }
}

/** What a dragged connection carries, and which end it came from. */
export type LinkFilter = { from: "output"; kind: IOKind } | { from: "input"; kind: PortKind };

export interface NodeSearchHit {
  type: WorkflowNodeType;
  label: string;
  category: NodeCategory;
  /** Settings the new step should start with to fit the connection (an
   * asset of the kind the input wants). */
  params?: Record<string, unknown>;
  /** A block saved in the library: the new step is an instance of a copy. */
  libraryId?: string;
}

/** What the search shows a hit as, unique among hits. */
export function hitKey(hit: NodeSearchHit): string {
  return hit.libraryId ? `block-${hit.libraryId}` : hit.type;
}

/** Whether a new step of this type can take, or feed, the dragged link. */
function fits(type: WorkflowNodeType, filter: LinkFilter): Record<string, unknown> | false {
  const schema = NODE_SCHEMAS[type];
  if (filter.from === "output") {
    // A text input takes anything by describing it; the search offers only
    // the steps that take what is dragged as it is.
    const ports = openInputPorts(schema, defaultParams(type));
    return ports.some((port) => isIdealMatch(filter.kind, port.kind)) ? {} : false;
  }
  if (
    type === "asset" &&
    (filter.kind === "image" || filter.kind === "video" || filter.kind === "audio")
  ) {
    return { assetKind: filter.kind };
  }
  return schema.output !== "none" && isInputCompatible(schema.output, filter.kind) ? {} : false;
}

/** How well `text` answers `query`: every query letter in order, with
 * bonuses for a word start and for consecutive letters. Zero is no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const s = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    if (char === " ") continue;
    const at = s.indexOf(char, from);
    if (at < 0) return 0;
    score += 1;
    if (at === previous + 1) score += 2;
    if (at === 0 || s[at - 1] === " ") score += 3;
    previous = at;
    from = at + 1;
  }
  return score;
}

/** Step types matching the query (and the dragged link), best first, within
 * the order of their categories. */
export function searchNodeTypes(
  query: string,
  filter?: LinkFilter,
  /** Blocks saved in the library, by name. */
  libraryBlocks: ReadonlyArray<{ id: string; name: string; description?: string }> = [],
): NodeSearchHit[] {
  const order: NodeCategory[] = ["inputs", "generate", "montage", "flow", "blocks"];
  const hits: Array<NodeSearchHit & { score: number }> = [];
  for (const type of Object.keys(NODE_SCHEMAS) as WorkflowNodeType[]) {
    // A block step is always an instance of a block: made from a selection
    // or taken from the library, never blank.
    if (type === "block" || type === "listItem") continue;
    const params = filter ? fits(type, filter) : {};
    if (params === false) continue;
    const label = nodeTypeLabel(type);
    const score = Math.max(fuzzyScore(query, label) * 2, fuzzyScore(query, keywords(type)));
    if (score === 0) continue;
    hits.push({
      type,
      label,
      category: CATEGORY[type],
      score,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    });
  }
  // A library block is offered when nothing is being wired: which of its
  // inputs a dragged link should land on is the person's call.
  if (!filter) {
    for (const block of libraryBlocks) {
      const score = Math.max(
        fuzzyScore(query, block.name) * 2,
        fuzzyScore(query, `${block.description ?? ""} ${keywords("block")}`),
      );
      if (score === 0) continue;
      hits.push({
        type: "block",
        label: block.name,
        category: "blocks",
        score,
        libraryId: block.id,
      });
    }
  }
  const typed = query.trim() !== "";
  return hits
    .sort((a, b) =>
      typed ? b.score - a.score : order.indexOf(a.category) - order.indexOf(b.category),
    )
    .map(({ score: _score, ...hit }) => hit);
}
