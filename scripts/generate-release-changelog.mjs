import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Tags mark published releases. Version bumps are usually merged through a PR,
// so their subjects are not on the first-parent history used for release notes.
// Recognize those subjects only as a fallback for a checkout without tags.
const RELEASE_SUBJECT_RE =
  /^(?:release: v|chore\(release\): bump to v?)(\d+\.\d+\.\d+)(?:\b|[^0-9])/;
// The trailer lines a commit body may carry; they are not release notes.
const TRAILER_RE = /^(?:Co-Authored-By|Claude-Session|Signed-off-by):/i;
const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";

export function parsePreviousReleaseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const [hash, subject] = trimmed.split(FIELD_SEPARATOR);
  const match = RELEASE_SUBJECT_RE.exec(subject ?? "");
  if (!hash || !match) return undefined;
  return { hash, version: match[1] };
}

export function findPreviousRelease(log) {
  return log.split("\n").map(parsePreviousReleaseLine).find(Boolean);
}

export function findPreviousReleaseTag(tags) {
  return tags
    .split("\n")
    .map((tag) => tag.trim())
    .find((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
}

export function parseGitLogRecords(log) {
  return log
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = "", subject = "", body = ""] = record.split(FIELD_SEPARATOR);
      return {
        hash: hash.trim(),
        subject: subject.trim(),
        body: body.trim(),
      };
    })
    .filter((entry) => entry.hash && entry.subject);
}

export function releaseNoteTitleForCommit(commit) {
  const release = RELEASE_SUBJECT_RE.exec(commit.subject);
  if (release) return undefined;

  const merge = /^Merge pull request #(\d+) from .+/.exec(commit.subject);
  if (merge) {
    const title = commit.body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !TRAILER_RE.test(line));
    return title ? `${title} (#${merge[1]})` : undefined;
  }

  return commit.subject;
}

export function formatChangelog({ version, previousVersion, commits }) {
  const lines = [`## Sub Rosa v${version}`, ""];
  if (previousVersion) {
    lines.push(`Changes since v${previousVersion}.`, "");
  } else {
    lines.push("Initial release changelog.", "");
  }

  const titles = commits
    .map(releaseNoteTitleForCommit)
    .filter((title) => title && !RELEASE_SUBJECT_RE.test(title));

  lines.push("### Changes");
  if (titles.length === 0) {
    lines.push("- No source changes recorded since the previous release.");
  } else {
    for (const title of titles) {
      lines.push(`- ${title}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * `<version> <output-path> [--to <ref>]`. The output path `-` writes to
 * stdout only. `--to` builds the notes as of another ref than HEAD, so a
 * past release can be regenerated from any checkout as a dry run:
 * `node scripts/generate-release-changelog.mjs 1.89.0 - --to v1.89.0`.
 */
export function parseArgs(argv) {
  const positional = [];
  let to = "HEAD";
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--to") {
      to = argv[index + 1];
      index++;
      if (!to) throw new Error("--to needs a git ref");
    } else {
      positional.push(argv[index]);
    }
  }
  const [version, outputPath] = positional;
  if (!version || !outputPath || positional.length > 2) {
    throw new Error(
      "Usage: node scripts/generate-release-changelog.mjs <version> <output-path|-> [--to <ref>]",
    );
  }
  return { version, outputPath, to };
}

function previousRelease(to) {
  // `to` is the new bump commit (and, in CI, its release tag). Excluding it
  // avoids selecting the release being built. Tags can point at merge commits,
  // unlike bump subjects buried on the PR side of a merge.
  const tag = findPreviousReleaseTag(git(["tag", "--merged", `${to}^`, "--sort=-version:refname"]));
  if (tag) {
    return { hash: git(["rev-list", "-n", "1", tag]).trim(), version: tag.slice(1) };
  }
  const output = git(["log", "--first-parent", `--format=%H${FIELD_SEPARATOR}%s`, to]);
  return findPreviousRelease(output);
}

function commitsSince(hash, to) {
  const range = hash ? `${hash}..${to}` : to;
  const output = git([
    "log",
    "--first-parent",
    "--reverse",
    `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`,
    range,
  ]);
  return parseGitLogRecords(output);
}

async function main() {
  const { version, outputPath, to } = parseArgs(process.argv.slice(2));
  const release = previousRelease(to);
  const changelog = formatChangelog({
    version,
    previousVersion: release?.version,
    commits: commitsSince(release?.hash, to),
  });
  if (outputPath !== "-") await writeFile(outputPath, changelog);
  process.stdout.write(changelog);
}

// Compare paths, not URLs: `import.meta.url` percent-encodes a space in the
// checkout path ("Sub%20Rosa") while argv[1] carries it raw, and the string
// comparison silently never matched, so `main()` never ran locally.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
