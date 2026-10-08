#!/usr/bin/env node
/**
 * Gets the iOS release lane (ios-release.yml) its App Store profiles through
 * the App Store Connect API, so no one has to make them by hand.
 *
 *   node scripts/ios-provision.mjs provision
 *     For each bundle of the archive (scripts/ios-signing.mjs): registers its
 *     bundle id when missing, turns on the capabilities the lane owns
 *     (HealthKit on the app), and finds its App Store profile signed by the
 *     imported distribution certificate, making a new one when it is missing
 *     or stale. Installs the profiles, writes <key>-profile.plist and a
 *     manifest under RUNNER_TEMP, and exports IOS_DROPPED_BUNDLES and
 *     IOS_EXPECTED_BUNDLES to GITHUB_ENV.
 *
 *   node scripts/ios-provision.mjs export-options <out.plist>
 *     Writes the ExportOptions for the bundles the manifest kept.
 *
 * The old profile secrets are a fallback for when the API cannot be reached.
 * A bundle without a profile is left out (only the app is required).
 *
 * Environment: APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_API_KEY_P8 (base64),
 * IOS_DIST_CERT_SERIAL (read from the keychain), IOS_DIST_CERT_ID (optional),
 * the profile secrets named in TARGETS, RUNNER_TEMP, GITHUB_ENV, APPLE_TEAM_ID.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiPaths,
  apiToken,
  bundleIdPayload,
  candidateProfiles,
  capabilityPayload,
  DEFAULT_CERTIFICATE_ID,
  exactBundleId,
  exportOptions,
  fatalForNewProfile,
  freshProfileName,
  missingCapabilities,
  mixedSigning,
  parsePlist,
  pickCertificate,
  planTargets,
  profileMatchesBundle,
  profilePayload,
  profileProblems,
  profileXml,
  renderPlist,
  requiredEntitlements,
  TARGETS,
} from "./ios-signing.mjs";

const API = "https://api.appstoreconnect.apple.com/v1/";
const temp = process.env.RUNNER_TEMP || tmpdir();
const manifestPath = join(temp, "ios-signing.json");

function warn(message) {
  console.log(`::warning::${message}`);
}

function describe(problems) {
  return problems.map((problem) => problem.detail).join(", ");
}

function apiClient() {
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;
  const p8 = process.env.APPLE_API_KEY_P8;
  if (!keyId || !issuer || !p8) throw new Error("APPLE_API_KEY_ID/ISSUER/KEY_P8 are not set");
  const privateKeyPem = Buffer.from(p8, "base64").toString("utf8");
  const token = apiToken({ keyId, issuer, privateKeyPem });

  return async function call(path, { method = "GET", body } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await fetch(API + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          continue;
        }
        throw new Error(`${method} ${path}: ${error.message}`);
      }
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        continue;
      }
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const detail = json.errors?.map((error) => error.detail || error.title).join("; ");
        throw new Error(`${method} ${path}: ${response.status} ${detail ?? ""}`.trim());
      }
      return json;
    }
  };
}

async function ensureBundleId(call, target) {
  const listed = await call(apiPaths.bundleIds(target.bundleId));
  const existing = exactBundleId(listed.data ?? [], target.bundleId);
  if (existing) return existing;
  const created = await call("bundleIds", { method: "POST", body: bundleIdPayload(target) });
  console.log(`  registered the bundle id ${target.bundleId}`);
  return created.data;
}

/** Returns the capability types the bundle has once the lane is done. */
async function ensureCapabilities(call, target, bundle) {
  const listed = await call(apiPaths.bundleIdCapabilities(bundle.id));
  const enabled = (listed.data ?? []).map((capability) => capability.attributes?.capabilityType);
  for (const type of missingCapabilities(target.capabilities, enabled)) {
    try {
      await call("bundleIdCapabilities", {
        method: "POST",
        body: capabilityPayload(bundle.id, type),
      });
      enabled.push(type);
      console.log(`  turned on ${type} for ${target.bundleId}`);
    } catch (error) {
      warn(`Could not turn on ${type} for ${target.bundleId} (${error.message}).`);
    }
  }
  return enabled;
}

function profileFromContent(content, source) {
  const plist = parsePlist(profileXml(content));
  return {
    content: Buffer.from(content, "base64"),
    plist,
    name: plist.Name,
    uuid: plist.UUID,
    managed: plist.IsXcodeManaged === true,
    source,
  };
}

async function profileFromApi(context, target) {
  const { call, certificate, profiles } = context;
  const bundle = await ensureBundleId(call, target);
  const capabilities = await ensureCapabilities(call, target, bundle);
  const wanted = {
    certificateId: certificate.id,
    certificateContent: certificate.attributes?.certificateContent,
    entitlements: requiredEntitlements(capabilities),
    appGroups: target.appGroups,
  };

  const candidates = candidateProfiles(profiles, target, bundle.id);
  const stale = [];
  for (const candidate of candidates) {
    const attributes = candidate.attributes ?? {};
    const plist = attributes.profileContent
      ? parsePlist(profileXml(attributes.profileContent))
      : undefined;
    const problems = profileProblems({
      ...wanted,
      attributes,
      plist,
      certificateIds: (candidate.relationships?.certificates?.data ?? []).map((entry) => entry.id),
    });
    if (problems.length === 0 && attributes.profileContent) {
      console.log(`  ${attributes.name} is current`);
      return profileFromContent(attributes.profileContent, "api");
    }
    console.log(`  ${attributes.name} is stale: ${describe(problems) || "no content"}`);
    stale.push(candidate);
  }

  const taken = [];
  for (const candidate of stale) {
    try {
      await call(apiPaths.profile(candidate.id), { method: "DELETE" });
      console.log(`  deleted ${candidate.attributes?.name}`);
    } catch (error) {
      warn(`Could not delete ${candidate.attributes?.name} (${error.message}).`);
      taken.push(candidate.attributes?.name);
    }
  }
  const name = freshProfileName(target.profileName, taken);
  const created = await call("profiles", {
    method: "POST",
    body: profilePayload({ name, bundleIdResourceId: bundle.id, certificateId: certificate.id }),
  });
  const profile = profileFromContent(created.data.attributes.profileContent, "api");
  console.log(`  made ${name} (${profile.uuid})`);
  const problems = profileProblems({
    ...wanted,
    attributes: created.data.attributes,
    plist: profile.plist,
    certificateIds: [certificate.id],
  });
  const fatal = fatalForNewProfile(problems);
  if (fatal.length > 0) {
    throw new Error(
      `the new profile ${describe(fatal)}: associate the group with ${target.bundleId} in the developer portal`,
    );
  }
  if (problems.length > 0) warn(`${name}: ${describe(problems)}.`);
  return profile;
}

function profileFromSecret(target) {
  const secret = process.env[target.secret];
  if (!secret) return null;
  const profile = profileFromContent(secret, "secret");
  if (!profileMatchesBundle(profile.plist, target.bundleId)) {
    warn(`${target.secret} is not a profile for ${target.bundleId}; ignoring it.`);
    return null;
  }
  const problems = profileProblems({ plist: profile.plist, appGroups: target.appGroups });
  if (problems.length > 0) warn(`${target.secret}: ${describe(problems)}.`);
  return profile;
}

function install(profile) {
  const dirs = [
    join(homedir(), "Library/MobileDevice/Provisioning Profiles"),
    // Xcode 16 and later read profiles from here.
    join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${profile.uuid}.mobileprovision`), profile.content);
  }
}

async function provision() {
  let context = null;
  try {
    const call = apiClient();
    const certificates = await call(apiPaths.distributionCertificates());
    const certificate = pickCertificate(certificates.data ?? [], {
      id: process.env.IOS_DIST_CERT_ID || DEFAULT_CERTIFICATE_ID,
      serial: process.env.IOS_DIST_CERT_SERIAL,
    });
    if (!certificate) throw new Error("the imported distribution certificate is not on the team");
    console.log(`Distribution certificate: ${certificate.id}`);
    const profiles = await call(apiPaths.appStoreProfiles());
    context = { call, certificate, profiles: profiles.data ?? [] };
  } catch (error) {
    warn(`App Store Connect is unavailable (${error.message}); using the profile secrets.`);
  }

  const obtained = {};
  for (const target of TARGETS) {
    console.log(`${target.bundleId}:`);
    let profile = null;
    if (context) {
      try {
        profile = await profileFromApi(context, target);
      } catch (error) {
        warn(`No profile from App Store Connect for ${target.bundleId}: ${error.message}.`);
      }
    }
    if (!profile) {
      profile = profileFromSecret(target);
      if (profile) console.log(`  using ${target.secret} (${profile.name})`);
    }
    obtained[target.key] = profile;
  }

  const { kept, dropped, appMissing } = planTargets(TARGETS, obtained);
  for (const entry of dropped) {
    warn(`${entry.bundleId} is left out of this build (${entry.reason}).`);
  }
  if (appMissing) {
    console.log(
      "::error::No App Store profile for the app: neither App Store Connect nor IOS_PROVISION_PROFILE gave one.",
    );
    process.exit(1);
  }
  if (mixedSigning(kept)) {
    warn("Xcode-managed and portal profiles are mixed; the export can sign neither way.");
  }

  for (const entry of kept) {
    install(entry.profile);
    writeFileSync(join(temp, `${entry.key}-profile.plist`), profileXml(entry.profile.content));
  }
  const manifest = {
    kept: kept.map((entry) => ({
      key: entry.key,
      bundleId: entry.bundleId,
      source: entry.profile.source,
      profile: {
        name: entry.profile.name,
        uuid: entry.profile.uuid,
        managed: entry.profile.managed,
      },
    })),
    dropped: dropped.map(({ key, bundleId, reason }) => ({ key, bundleId, reason })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of manifest.kept) {
    console.log(`Signing ${entry.bundleId} with ${entry.profile.name} (${entry.source})`);
  }
  if (process.env.GITHUB_ENV) {
    appendFileSync(
      process.env.GITHUB_ENV,
      `IOS_DROPPED_BUNDLES=${dropped.map((entry) => entry.bundleId).join(" ")}\n` +
        `IOS_EXPECTED_BUNDLES=${kept.length}\n`,
    );
  }
}

function writeExportOptions(out) {
  if (!out) throw new Error("Usage: ios-provision.mjs export-options <out.plist>");
  const teamId = process.env.APPLE_TEAM_ID;
  if (!teamId) throw new Error("APPLE_TEAM_ID is not set");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const options = exportOptions({ teamId, kept: manifest.kept });
  writeFileSync(out, renderPlist(options));
  console.log("Export signing style:", options.signingStyle);
}

const [command = "provision", argument] = process.argv.slice(2);
if (command === "provision") {
  await provision();
} else if (command === "export-options") {
  writeExportOptions(argument);
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
