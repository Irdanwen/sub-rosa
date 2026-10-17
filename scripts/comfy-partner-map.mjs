// Regenerates the frozen table of ComfyUI's partner nodes, the ones that call
// a hosted model, which the workflow importer reads
// (src/lib/studio/workflow/comfy/partner-nodes.json):
//
//   node scripts/comfy-partner-map.mjs <path to a ComfyUI checkout>
//
// The table is committed and read as data: the importer never reads ComfyUI
// itself. For each node it keeps what the importer decides with: what the
// node makes, whose model it calls, and which media it takes (a picture, a
// clip, a sound), with the input names, which tell a first frame from a
// reference. Regenerate it when ComfyUI adds partner nodes (ADR-0075).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/comfy-partner-map.mjs <path to ComfyUI>");
  process.exit(1);
}
const dir = path.join(root, "comfy_api_nodes");
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src/lib/studio/workflow/comfy/partner-nodes.json",
);

const MAKES = {
  Video: "video",
  Image: "image",
  Audio: "audio",
  String: "text",
  SVG: "svg",
  Mask: "mask",
};

const table = {};
for (const file of fs
  .readdirSync(dir)
  .filter((name) => /^nodes_.*\.py$/.test(name))
  .sort()) {
  const source = fs.readFileSync(path.join(dir, file), "utf8");
  const stem = file.replace(/^nodes_/, "").replace(/\.py$/, "");
  for (const chunk of source.split(/IO\.Schema\(/).slice(1)) {
    // The schema only: what follows it (the node's code) says nothing here.
    const schema = chunk.split(/\n\s*hidden=|\n\s*is_output_node=|\n {4}@classmethod|\nclass /)[0];
    const id = /node_id="([^"]+)"/.exec(schema)?.[1];
    if (!id) continue;
    const category = /category="([^"]+)"/.exec(schema)?.[1] ?? "";
    const outputs = schema.split(/outputs=\[/)[1] ?? "";
    const inputs = schema.split(/outputs=\[/)[0].split(/inputs=\[/)[1] ?? "";
    const first = /IO\.([A-Za-z0-9]+)\.Output/.exec(outputs)?.[1] ?? "";
    // A node whose output is a type of its own says what it makes through
    // its category ("partner/3d/Tripo").
    const kind = category.startsWith("partner/") ? category.split("/")[1] : "";
    const makes = first.startsWith("File3D") || kind === "3d" ? "3d" : (MAKES[first] ?? "other");
    const takes = [];
    for (const match of inputs.matchAll(/IO\.(Image|Video|Audio)\.Input\(\s*"([^"]+)"/g)) {
      takes.push(`${match[1].toLowerCase()}:${match[2]}`);
    }
    const provider = category.startsWith("partner/") ? category.split("/")[2] : stem;
    table[id] = { makes, provider, takes };
  }
}

const sorted = Object.fromEntries(
  Object.keys(table)
    .sort()
    .map((key) => [key, table[key]]),
);
fs.writeFileSync(OUT, `${JSON.stringify(sorted, null, 2)}\n`);
// Written the way the repository formats JSON, so a regeneration diffs only
// what changed.
execFileSync("pnpm", ["exec", "biome", "format", "--write", OUT], { stdio: "ignore" });
console.log(
  `${Object.keys(sorted).length} partner nodes written to ${path.relative(process.cwd(), OUT)}`,
);
