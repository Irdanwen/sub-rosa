import { writeFile } from "node:fs/promises";

const api = "https://api.github.com/repos/Irdanwen/sub-rosa-releases/releases";
async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "subrosa-release-manifest" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Release API returned ${response.status}`);
  return response.json();
}
/** Only the official release repository, over HTTPS, under the release's own tag. */
function verifiedAsset(asset, tag) {
  const url = new URL(asset.browser_download_url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith(`/Irdanwen/sub-rosa-releases/releases/download/${tag}/`) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0
  )
    throw new Error("Invalid release artifact");
  return {
    url: url.href,
    bytes: asset.size,
    sha256: /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") ? asset.digest.slice(7) : null,
  };
}
const release = await fetchJson(`${api}/latest`);
if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name))
  throw new Error("Expected a stable release");
const targets = [
  ["mac-arm", /darwin-aarch64-.*\.dmg$/],
  ["mac-intel", /darwin-x86_64-.*\.dmg$/],
  ["windows", /windows-x86_64-.*-setup\.exe$/],
];
const assets = targets.flatMap(([platform, pattern]) => {
  const asset = release.assets.find((item) => pattern.test(item.name));
  return asset ? [{ platform, ...verifiedAsset(asset, release.tag_name) }] : [];
});
if (!assets.length) throw new Error("No downloadable artifacts in release");

// Android test builds are separate prereleases (android-vX.Y.Z-<build>), so
// `latest` never sees them. The newest build number wins. Only the APK is
// offered: the AAB is for Play Console and cannot be installed directly.
const androidTag = /^android-v(\d+\.\d+\.\d+)-(\d+)$/;
const buildOf = (item) => Number(item.tag_name.match(androidTag)[2]);
// The list is ordered by the tag's commit date, which every release of this
// repository shares, so the Android entries sit anywhere: read every page.
const androidReleases = [];
for (let page = 1; page <= 10; page += 1) {
  const items = await fetchJson(`${api}?per_page=100&page=${page}`);
  androidReleases.push(
    ...items.filter((item) => !item.draft && item.prerelease && androidTag.test(item.tag_name)),
  );
  if (items.length < 100) break;
}
const androidRelease = androidReleases.sort((a, b) => buildOf(b) - buildOf(a))[0];
let android = null;
if (androidRelease) {
  const [, version] = androidRelease.tag_name.match(androidTag);
  const apk = androidRelease.assets.find((item) => /^subrosa-.*-arm64\.apk$/.test(item.name));
  if (!apk) throw new Error("Android prerelease has no APK");
  android = {
    version: `v${version}`,
    build: buildOf(androidRelease),
    published_at: androidRelease.published_at,
    release_url: androidRelease.html_url,
    ...verifiedAsset(apk, androidRelease.tag_name),
  };
}
await writeFile(
  new URL("../src/releases.json", import.meta.url),
  `${JSON.stringify(
    {
      version: release.tag_name,
      published_at: release.published_at,
      release_url: release.html_url,
      assets,
      android,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `Verified ${assets.length} download artifacts for ${release.tag_name}` +
    (android ? ` and Android build ${android.build}\n` : "; no Android prerelease\n"),
);
