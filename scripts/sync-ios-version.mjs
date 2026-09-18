/**
 * Stamps the iOS project files with the version in tauri.conf.json.
 *
 * `tauri ios build` writes the real version into the generated app Info.plist
 * but leaves the share extension alone, so the two drift and App Store Connect
 * answers ITMS-90473. Deriving both from one source removes the drift; a test
 * fails when they disagree, which is cheaper than hearing it from Apple.
 */
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"));
const version = config.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected version: ${version}`);

const targets = [
  "src-tauri/gen/apple/project.yml",
  "src-tauri/gen/apple/os-june_iOS/Info.plist",
  "src-tauri/gen/apple/ShareExtension/Info.plist",
];
for (const path of targets) {
  const url = new URL(path, root);
  const before = await readFile(url, "utf8");
  const after = before
    .replace(/(CFBundleShortVersionString:\s*)[\d.]+/g, `$1${version}`)
    .replace(/(CFBundleVersion:\s*")[\d.]+(")/g, `$1${version}$2`)
    .replace(
      /(<key>CFBundle(?:ShortVersionString|Version)<\/key>\s*<string>)[\d.]+(<\/string>)/g,
      `$1${version}$2`,
    );
  if (after !== before) await writeFile(url, after);
  process.stdout.write(`${path}: ${version}\n`);
}
