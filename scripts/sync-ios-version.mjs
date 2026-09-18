/**
 * Stamps the iOS project files with the version in tauri.conf.json.
 *
 * `tauri ios build` writes the real version into the generated app Info.plist
 * but leaves the share extension alone, so the two drift and App Store Connect
 * answers ITMS-90473. Deriving both from one source removes the drift; a test
 * fails when they disagree, which is cheaper than hearing it from Apple.
 *
 * CFBundleShortVersionString is the version a person reads. CFBundleVersion is
 * a build counter Apple requires to be unique and strictly increasing, so it
 * cannot be the same value: a delivery rejected for signing could never be
 * sent again under its own version. SUBROSA_IOS_BUILD carries that counter in
 * CI; without it both stay on the app version, which is what a local build and
 * the committed files want.
 */
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"));
const version = config.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected version: ${version}`);

const build = process.env.SUBROSA_IOS_BUILD?.trim() || version;
if (!/^\d+(\.\d+)*$/.test(build)) throw new Error(`Unexpected build number: ${build}`);

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
    .replace(/(CFBundleVersion:\s*")[\d.]+(")/g, `$1${build}$2`)
    .replace(
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)[\d.]+(<\/string>)/g,
      `$1${version}$2`,
    )
    .replace(/(<key>CFBundleVersion<\/key>\s*<string>)[\d.]+(<\/string>)/g, `$1${build}$2`);
  if (after !== before) await writeFile(url, after);
  process.stdout.write(`${path}: ${version} (build ${build})\n`);
}
