import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The iPhone's Shortcuts actions are Swift in the app target
 * (`gen/apple/Sources/os-june/Intents`), handing requests to Rust through the
 * app group (`src-tauri/src/intent_inbox.rs`). Nothing builds them in CI but
 * the iOS release lane, so the wiring that would only fail there is pinned
 * here.
 */
const apple = "src-tauri/gen/apple";
const intents = join(apple, "Sources/os-june/Intents");
const project = readFileSync(join(apple, "os-june.xcodeproj/project.pbxproj"), "utf8");
const spec = readFileSync(join(apple, "project.yml"), "utf8");
const inboxRust = readFileSync("src-tauri/src/intent_inbox.rs", "utf8");
const swift = readdirSync(intents)
  .filter((name) => name.endsWith(".swift"))
  .map((name) => ({ name, source: readFileSync(join(intents, name), "utf8") }));

function strings(path) {
  const entries = new Map();
  for (const match of readFileSync(path, "utf8").matchAll(/^"(.*)"\s*=\s*"(.*)";$/gm)) {
    entries.set(match[1], match[2]);
  }
  return entries;
}

describe("the Shortcuts actions", () => {
  it("compile into the app target, not the share extension", () => {
    for (const { name } of swift) {
      expect(project).toContain(`${name} in Sources`);
    }
    expect(spec).toMatch(/os-june_Share:[\s\S]*- path: ShareExtension/);
    expect(spec).toContain("SWIFT_VERSION: 5.0");
  });

  it("link AppIntents weakly, and keep the app on iOS 15", () => {
    expect(project).toMatch(/AppIntents\.framework in Frameworks \*\/ = \{[^}]*Weak/);
    expect(spec).toMatch(/deploymentTarget:\s*\n\s*iOS: 15\.0/);
  });

  it("gate every intent and the provider on iOS 16", () => {
    for (const { source } of swift) {
      const types = source.match(/^struct \w+: (AppIntent|AppShortcutsProvider)/gm) ?? [];
      const gated = source.match(/@available\(iOS 16\.0, \*\)\nstruct /g) ?? [];
      expect(gated.length).toBe(types.length);
    }
  });

  it("speak French wherever they speak English", () => {
    for (const table of ["Localizable.strings", "AppShortcuts.strings"]) {
      const english = strings(join(intents, "en.lproj", table));
      const french = strings(join(intents, "fr.lproj", table));
      expect([...french.keys()].sort()).toEqual([...english.keys()].sort());
    }
    for (const phrase of strings(join(intents, "en.lproj/AppShortcuts.strings")).keys()) {
      expect(phrase).toMatch(/\$\{applicationName\}/);
    }
  });

  it("agree with Rust on the inbox and the actions", () => {
    const inbox = swift.find(({ name }) => name === "IntentInbox.swift")?.source ?? "";
    expect(inbox).toContain('static let directory = "intent-inbox"');
    expect(inboxRust).toContain('const INBOX_DIR: &str = "intent-inbox";');
    const actions = [
      ...new Set(
        swift.flatMap(({ source }) =>
          [...source.matchAll(/deliver\(action: "(\w+)"/g)].map((match) => match[1]),
        ),
      ),
    ].sort();
    expect(actions).toEqual(["ask", "dictate", "record"]);
    for (const action of actions) expect(inboxRust).toContain(`"${action}" => "${action}"`);
  });
});
