import { writeFile } from "node:fs/promises";

const source = "https://api.github.com/repos/Irdanwen/sub-rosa-releases/releases/latest";
const response = await fetch(source, {
  headers: { Accept: "application/vnd.github+json", "User-Agent": "subrosa-release-manifest" },
  signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`Release API returned ${response.status}`);
const release = await response.json();
if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name))
  throw new Error("Expected a stable release");
const targets = [
  ["mac-arm", /darwin-aarch64-.*\.dmg$/],
  ["mac-intel", /darwin-x86_64-.*\.dmg$/],
  ["windows", /windows-x86_64-.*-setup\.exe$/],
];
const assets = targets.flatMap(([platform, pattern]) => {
  const asset = release.assets.find((item) => pattern.test(item.name));
  if (!asset) return [];
  const url = new URL(asset.browser_download_url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith(
      `/Irdanwen/sub-rosa-releases/releases/download/${release.tag_name}/`,
    ) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0
  )
    throw new Error("Invalid release artifact");
  return [
    {
      platform,
      url: url.href,
      bytes: asset.size,
      sha256: /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") ? asset.digest.slice(7) : null,
    },
  ];
});
if (!assets.length) throw new Error("No downloadable artifacts in release");
await writeFile(
  new URL("../src/releases.json", import.meta.url),
  `${JSON.stringify(
    {
      version: release.tag_name,
      published_at: release.published_at,
      release_url: release.html_url,
      assets,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`Verified ${assets.length} download artifacts for ${release.tag_name}\n`);
