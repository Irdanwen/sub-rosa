// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// `tauri build` refuses to run when an npm package and its Rust crate sit on
// different minor releases ("Found version mismatched Tauri packages"). A
// caret range let `@tauri-apps/plugin-notification` drift to 2.6 over a 2.5
// crate (2026-10-11), and the updater did the same before (2026-10-10); the
// release build was the first place either showed. This holds the pairs here.

/** A file of the repository; Vitest runs from its root. */
const read = (path: string): string => readFileSync(path, "utf8") as string;

const manifest = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
};
const lock = read("pnpm-lock.yaml");
const cargoLock = read("src-tauri/Cargo.lock");

/** The crate a Tauri npm package pairs with. */
const crateFor = (name: string): string =>
  name === "@tauri-apps/api" ? "tauri" : `tauri-${name.slice("@tauri-apps/".length)}`;

/** The version the root importer of pnpm-lock.yaml resolved. */
function lockedNpm(name: string): string {
  const block = new RegExp(
    `\\n      '${name}':\\n        specifier: [^\\n]+\\n        version: ([0-9.]+)`,
  );
  const match = block.exec(lock);
  if (!match) throw new Error(`${name} is not in pnpm-lock.yaml`);
  return match[1];
}

/** Every version of a crate in Cargo.lock (one, unless two majors coexist). */
function lockedCrates(name: string): string[] {
  const entry = new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([0-9.]+)"`, "g");
  return [...cargoLock.matchAll(entry)].map((match) => match[1]);
}

const minor = (version: string): string => version.split(".").slice(0, 2).join(".");

const paired = Object.keys(manifest.dependencies).filter(
  (name) => name === "@tauri-apps/api" || name.startsWith("@tauri-apps/plugin-"),
);

describe("Tauri npm packages and their crates", () => {
  it("finds the packages to pair", () => {
    expect(paired).toContain("@tauri-apps/api");
    expect(paired.length).toBeGreaterThan(5);
  });

  it.each(paired)("%s stays on its crate's minor release", (name) => {
    const crates = lockedCrates(crateFor(name));
    expect(crates, `${crateFor(name)} in Cargo.lock`).toHaveLength(1);
    expect(minor(lockedNpm(name))).toBe(minor(crates[0]));
  });

  it.each(paired)("%s takes a tilde range, so a new minor waits for its crate", (name) => {
    expect(manifest.dependencies[name]).toMatch(/^~/);
  });
});
