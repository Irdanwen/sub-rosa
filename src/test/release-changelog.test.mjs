import { describe, expect, it } from "vitest";
import {
  findPreviousRelease,
  formatChangelog,
  parseGitLogRecords,
  parsePreviousReleaseLine,
  releaseNoteTitleForCommit,
} from "../../scripts/generate-release-changelog.mjs";

const field = "\x1f";
const record = "\x1e";

describe("parsePreviousReleaseLine", () => {
  it("extracts the release commit and version from the latest release subject", () => {
    expect(parsePreviousReleaseLine(`64be701${field}release: v0.0.22 (#508)`)).toEqual({
      hash: "64be701",
      version: "0.0.22",
    });
  });

  it("ignores unrelated commits", () => {
    expect(parsePreviousReleaseLine(`b1fc9eb${field}Fix system audio (#511)`)).toBeUndefined();
  });

  it("recognises the fork's version bump commits as releases", () => {
    expect(parsePreviousReleaseLine(`615c1d88${field}chore(release): bump to 1.58.0`)).toEqual({
      hash: "615c1d88",
      version: "1.58.0",
    });
    expect(parsePreviousReleaseLine(`0a1b2c3d${field}chore(release): bump to v1.59.0`)).toEqual({
      hash: "0a1b2c3d",
      version: "1.59.0",
    });
  });
});

describe("findPreviousRelease", () => {
  it("ignores newer non-release subjects even if they mention release commits elsewhere", () => {
    const log = [
      `newer${field}Document release: v0.0.22 rollback notes`,
      `older${field}release: v0.0.22 (#508)`,
    ].join("\n");

    expect(findPreviousRelease(log)).toEqual({
      hash: "older",
      version: "0.0.22",
    });
  });
});

describe("parseGitLogRecords", () => {
  it("parses git log records separated by control characters", () => {
    expect(
      parseGitLogRecords(
        [
          `abc123${field}Fix updater notes (#1)${field}`,
          `def456${field}Merge pull request #2 from branch${field}Add the feature`,
        ].join(record),
      ),
    ).toEqual([
      {
        hash: "abc123",
        subject: "Fix updater notes (#1)",
        body: "",
      },
      {
        hash: "def456",
        subject: "Merge pull request #2 from branch",
        body: "Add the feature",
      },
    ]);
  });
});

describe("releaseNoteTitleForCommit", () => {
  it("uses squash commit subjects directly", () => {
    expect(
      releaseNoteTitleForCommit({
        hash: "abc123",
        subject: "Fix system audio permission refresh (#511)",
        body: "",
      }),
    ).toBe("Fix system audio permission refresh (#511)");
  });

  it("uses merge commit body titles with the PR number", () => {
    expect(
      releaseNoteTitleForCommit({
        hash: "abc123",
        subject: "Merge pull request #476 from open-software-network/topic",
        body: "\nAllow short onboarding practice replies\n",
      }),
    ).toBe("Allow short onboarding practice replies (#476)");
  });

  it("omits release commits", () => {
    expect(
      releaseNoteTitleForCommit({
        hash: "abc123",
        subject: "release: v0.0.22 (#508)",
        body: "",
      }),
    ).toBeUndefined();
    expect(
      releaseNoteTitleForCommit({
        hash: "abc124",
        subject: "chore(release): bump to 1.58.0",
        body: "",
      }),
    ).toBeUndefined();
  });

  it("skips trailer lines when a merge commit body starts with one", () => {
    expect(
      releaseNoteTitleForCommit({
        hash: "abc125",
        subject: "Merge pull request #9 from Irdanwen/topic",
        body: "Co-Authored-By: Someone <x@y.z>\nMake the thing work\n",
      }),
    ).toBe("Make the thing work (#9)");
  });
});

describe("formatChangelog", () => {
  it("formats a release changelog from commit titles", () => {
    expect(
      formatChangelog({
        version: "0.0.23",
        previousVersion: "0.0.22",
        commits: [
          {
            hash: "b1fc9eb",
            subject: "Fix system audio permission refresh (#511)",
            body: "",
          },
          {
            hash: "d164dc7",
            subject: "Update Conductor env setup (#512)",
            body: "",
          },
        ],
      }),
    ).toBe(
      [
        "## Sub Rosa v0.0.23",
        "",
        "Changes since v0.0.22.",
        "",
        "### Changes",
        "- Fix system audio permission refresh (#511)",
        "- Update Conductor env setup (#512)",
        "",
      ].join("\n"),
    );
  });

  it("keeps releases with no source changes explicit", () => {
    expect(
      formatChangelog({
        version: "0.0.23",
        previousVersion: "0.0.22",
        commits: [],
      }),
    ).toContain("- No source changes recorded since the previous release.");
  });
});
