/**
 * Stamps the iOS project files with the version in tauri.conf.json.
 *
 * `tauri ios build` writes the real version into the generated app Info.plist
 * but leaves the extensions and the watch app alone, so they drift and App
 * Store Connect answers ITMS-90473. Deriving both from one source removes the drift; a test
 * fails when they disagree, which is cheaper than hearing it from Apple.
 *
 * SUBROSA_IOS_BUILD carries the build counter in CI. Without it the build
 * number stays on the app version, which is what a local build and the
 * committed files want. See ios-build-number.mjs for the shape Apple accepts.
 */
import { readFile, writeFile } from "node:fs/promises";
import { iosBuildNumber } from "./ios-build-number.mjs";

const root = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"));
const version = config.version;

const build = iosBuildNumber(version, process.env.SUBROSA_IOS_BUILD?.trim());

const targets = [
  "src-tauri/gen/apple/project.yml",
  "src-tauri/gen/apple/os-june_iOS/Info.plist",
  "src-tauri/gen/apple/ShareExtension/Info.plist",
  // The widgets and the watch app with its complication (ADR-0095). A watch
  // app must carry its iPhone app's version exactly, or the upload is refused.
  "src-tauri/gen/apple/Widgets/Info.plist",
  "src-tauri/gen/apple/Watch/Info.plist",
  "src-tauri/gen/apple/WatchWidgets/Info.plist",
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
