/**
 * Builds the extension for each browser family and packs the store zips.
 *
 *   pnpm --filter @subrosa/browser-extension build
 *
 * dist/chrome      load unpacked in Chrome, Edge or Brave (keeps the `key`,
 *                  so the id is the one the app's host manifest allows)
 * dist/firefox     load as a temporary add-on in Firefox
 * dist/*.zip       what goes to the stores (docs/browser-extension.md)
 */
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumManifest, firefoxManifest, popupHtml } from "./flavors.mjs";
import { zip } from "./zip.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..");
const dist = join(root, "dist");
const base = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

const ICONS = { 32: "32x32.png", 64: "64x64.png", 128: "128x128.png" };

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function stage(flavor, manifest) {
  const out = join(dist, flavor);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "icons"), { recursive: true });
  cpSync(join(root, "_locales"), join(out, "_locales"), { recursive: true });
  cpSync(join(root, "src"), join(out, "src"), { recursive: true });
  cpSync(join(repo, "packages/design/primitives.css"), join(out, "src/primitives.css"));
  const panel = readFileSync(join(root, "src/panel.html"), "utf8");
  writeFileSync(join(out, "src/popup.html"), popupHtml(panel));
  for (const [size, file] of Object.entries(ICONS)) {
    cpSync(join(repo, "src-tauri/icons", file), join(out, "icons", `${size}.png`));
  }
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return out;
}

function pack(dir, manifest, name) {
  const files = listFiles(dir).map((path) => ({
    name: relative(dir, path),
    data: path.endsWith("manifest.json")
      ? Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
      : readFileSync(path),
  }));
  const target = join(dist, `${name}-${base.version}.zip`);
  writeFileSync(target, zip(files));
  return target;
}

mkdirSync(dist, { recursive: true });
const chrome = stage("chrome", chromiumManifest(base));
const firefox = stage("firefox", firefoxManifest(base));
const outputs = [
  pack(chrome, chromiumManifest(base, { forStore: true }), "subrosa-chromium"),
  pack(firefox, firefoxManifest(base), "subrosa-firefox"),
];
for (const output of [chrome, firefox, ...outputs]) {
  process.stdout.write(`${relative(repo, output)}\n`);
}
