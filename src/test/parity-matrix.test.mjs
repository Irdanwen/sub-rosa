import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * docs/parity/chatgpt.md is the definition of "no feature behind ChatGPT"
 * (ADR-0078). A matrix nobody checks is wrong the day after it is written, so
 * this reads it back: statuses come from a closed list, every claimed cell is
 * backed by a file of its own platform, a gap names the lot that closes it and
 * only a gap names a lot, an `equiv` is explained, a `gated` or `unverified`
 * cell names what it waits for, and the three counters the document
 * announces are the real ones.
 */
const doc = readFileSync("docs/parity/chatgpt.md", "utf8");

const STATUSES = new Set(["yes", "partial", "no", "equiv", "n/a", "gated", "unverified"]);
/** A cell with one of these claims the platform has something, so its own
 * evidence group must show it. */
const CLAIMS = new Set(["yes", "partial", "equiv", "gated", "unverified"]);
const GAPS = new Set(["no", "partial"]);
const PLATFORMS = ["Desktop", "iOS", "Android", "Web"];
/** The tag that opens each platform's evidence group. */
const TAGS = { Desktop: "D", iOS: "i", Android: "A", Web: "W" };

function section(title) {
  const start = doc.indexOf(`## ${title}\n`);
  if (start < 0) throw new Error(`docs/parity/chatgpt.md has no "## ${title}" section`);
  const rest = doc.slice(start + title.length + 4);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** `D: \`a\` \`b\` · i: \`c\`` → { D: ["a", "b"], i: ["c"] }, plus anything
 * outside a group, which the evidence rule refuses. */
function evidenceGroups(evidence) {
  const groups = {};
  const tagged = /(?:^|\s)([DiAW]):((?:\s*`[^`]+`)+)/g;
  for (const match of evidence.matchAll(tagged)) {
    const paths = [...match[2].matchAll(/`([^`]+)`/g)].map((path) => path[1]);
    groups[match[1]] = [...(groups[match[1]] ?? []), ...paths];
  }
  const stray = evidence.replace(tagged, " ").replace(/·/g, " ").trim();
  return { groups, stray };
}

/** A prose section with its line breaks folded, so a bold name wrapped across
 * two lines still reads as one. */
function prose(title) {
  return section(title).replace(/\s+/g, " ");
}

function rows() {
  return section("Matrix")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      const [feature, desktop, ios, android, web, evidence, lot] = cells;
      return {
        feature,
        cells,
        statuses: { Desktop: desktop, iOS: ios, Android: android, Web: web },
        evidence: evidenceGroups(evidence ?? ""),
        lot,
      };
    });
}

function counted(matrix, statuses) {
  return matrix.reduce(
    (total, row) =>
      total + PLATFORMS.filter((platform) => statuses.has(row.statuses[platform])).length,
    0,
  );
}

describe("the ChatGPT parity matrix", () => {
  const matrix = rows();

  it("has rows, each with seven cells and a unique feature", () => {
    expect(matrix.length).toBeGreaterThan(40);
    for (const row of matrix) expect(row.cells, row.feature).toHaveLength(7);
    const names = matrix.map((row) => row.feature);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses only the seven statuses", () => {
    for (const row of matrix) {
      for (const platform of PLATFORMS) {
        expect(STATUSES.has(row.statuses[platform]), `${row.feature} / ${platform}`).toBe(true);
      }
    }
  });

  it("writes every path inside a platform group", () => {
    for (const row of matrix) {
      expect(row.evidence.stray, `${row.feature}: evidence outside a D:/i:/A:/W: group`).toBe("");
    }
  });

  it("backs every claimed cell with an existing file of its own platform", () => {
    for (const row of matrix) {
      for (const platform of PLATFORMS) {
        const paths = row.evidence.groups[TAGS[platform]] ?? [];
        if (CLAIMS.has(row.statuses[platform])) {
          expect(
            paths.length,
            `${row.feature} / ${platform} is ${row.statuses[platform]} without ${TAGS[platform]}: evidence`,
          ).toBeGreaterThan(0);
        }
        for (const path of paths) expect(existsSync(path), `${row.feature}: ${path}`).toBe(true);
      }
    }
  });

  it("does not let a platform's group stand for a platform the row does not claim", () => {
    for (const row of matrix) {
      for (const platform of PLATFORMS) {
        if (row.evidence.groups[TAGS[platform]] && !CLAIMS.has(row.statuses[platform])) {
          throw new Error(
            `${row.feature}: ${TAGS[platform]}: evidence on a ${row.statuses[platform]} cell`,
          );
        }
      }
    }
  });

  it("names the lot that closes every gap, and a lot only for a gap", () => {
    for (const row of matrix) {
      const gap = PLATFORMS.some((platform) => GAPS.has(row.statuses[platform]));
      if (gap) expect(row.lot, row.feature).toMatch(/^P[0-9]$/);
      else expect(row.lot, `${row.feature} names a lot but has no gap`).toBe("");
    }
  });

  it("explains every gap under Known gaps", () => {
    const known = prose("Known gaps");
    for (const row of matrix) {
      if (PLATFORMS.some((platform) => GAPS.has(row.statuses[platform]))) {
        expect(known, `${row.feature} has a gap`).toContain(`**${row.feature}**`);
      }
    }
  });

  it("explains every assumed equivalence", () => {
    const explained = prose("Assumed equivalences");
    for (const row of matrix) {
      if (PLATFORMS.some((platform) => row.statuses[platform] === "equiv")) {
        expect(explained, `${row.feature} is marked equiv`).toContain(`**${row.feature}**`);
      }
    }
  });

  it("names what every gated cell waits for", () => {
    const gated = prose("Gated");
    for (const row of matrix) {
      const cells = PLATFORMS.filter((platform) => row.statuses[platform] === "gated");
      if (cells.length === 0) continue;
      // A row gated on the web alone is covered by the web column's entry.
      const named =
        gated.includes(`**${row.feature}**`) ||
        (cells.every((platform) => platform === "Web") && gated.includes("**Web column**"));
      expect(named, `${row.feature} is gated on ${cells.join(", ")}`).toBe(true);
    }
  });

  it("names the hardware every unverified cell has never run on", () => {
    const unverified = prose("Unverified");
    for (const row of matrix) {
      if (PLATFORMS.some((platform) => row.statuses[platform] === "unverified")) {
        expect(unverified, `${row.feature} is unverified`).toContain(`**${row.feature}**`);
      }
    }
  });

  it("names only real rows in the Gated, Unverified and Known gaps sections", () => {
    const features = new Set([...matrix.map((row) => row.feature), "Web column"]);
    for (const title of ["Known gaps", "Gated", "Unverified"]) {
      for (const match of prose(title).matchAll(/\*\*([^*]+)\*\*/g)) {
        expect(features.has(match[1]), `${title} names "${match[1]}"`).toBe(true);
      }
    }
  });

  it("announces the real gap, gated and unverified counts", () => {
    const gaps = counted(matrix, GAPS);
    const gated = counted(matrix, new Set(["gated"]));
    const unverified = counted(matrix, new Set(["unverified"]));
    expect(doc, `the matrix has ${gaps} gap cells`).toContain(`Gaps: ${gaps}\n`);
    expect(doc, `the matrix has ${gated} gated cells`).toContain(`Gated: ${gated}\n`);
    expect(doc, `the matrix has ${unverified} unverified cells`).toContain(
      `Unverified: ${unverified}\n`,
    );
  });
});

describe("evidenceGroups", () => {
  it("splits the tagged groups and keeps nothing stray", () => {
    const { groups, stray } = evidenceGroups("D: `a.rs` `b.ts` · i: `c.rs` · W: `d.tsx`");
    expect(groups).toEqual({ D: ["a.rs", "b.ts"], i: ["c.rs"], W: ["d.tsx"] });
    expect(stray).toBe("");
  });

  it("reports a path written outside any group", () => {
    expect(evidenceGroups("`a.rs` · D: `b.rs`").stray).toBe("`a.rs`");
  });
});
