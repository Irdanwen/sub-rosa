/**
 * Prints the CFBundleVersion this delivery should carry, for the workflow step
 * that writes it into the archive. Tauri's archive rewrites the value from
 * tauri.conf.json, so the counter has to be applied after it runs, and the
 * rule that shapes it lives in one place.
 */
import { readFile } from "node:fs/promises";
import { iosBuildNumber } from "./ios-build-number.mjs";

const config = JSON.parse(
  await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
process.stdout.write(iosBuildNumber(config.version, process.env.SUBROSA_IOS_BUILD?.trim()));
