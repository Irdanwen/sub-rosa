import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A class name with no rule behind it is a class that does nothing, and the
 * markup reads as though it does. `mobile-scroll` sat on the settings body
 * undefined: the account section could not be scrolled and its last field was
 * clipped by the tab bar, which looks like a layout bug and is a typo.
 */
const HOOKS_WITHOUT_STYLE = new Set([
  // Grouping elements that carry no styling of their own. Their children are
  // styled; the parent is here to be found, not to be painted.
  "mobile-action-sheet",
  "mobile-reference",
]);

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("mobile class names", () => {
  const css = ["src/styles/mobile.css", "src/styles/app.css", "src/styles/carpe-diem.css"]
    .map((path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
  const defined = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1]));

  it("all resolve to a rule", () => {
    const orphans = new Map();
    for (const file of [...walk("src/components/mobile"), ...walk("src/app/mobile")]) {
      for (const attribute of readFileSync(file, "utf8").matchAll(/className="([^"{}]+)"/g)) {
        for (const name of attribute[1].split(/\s+/)) {
          if (!name.startsWith("mobile-")) continue;
          if (defined.has(name) || HOOKS_WITHOUT_STYLE.has(name)) continue;
          orphans.set(name, [...(orphans.get(name) ?? []), file]);
        }
      }
    }
    expect(Object.fromEntries(orphans)).toEqual({});
  });

  it("the settings body can actually scroll", () => {
    // The reported bug, pinned: padding alone is not a scroll container.
    const rule = /\.mobile-scroll\s*\{([^}]*)\}/.exec(
      readFileSync("src/styles/mobile.css", "utf8"),
    );
    expect(rule?.[1]).toMatch(/overflow-y:\s*auto/);
    expect(rule?.[1]).toMatch(/min-height:\s*0/);
  });
});
