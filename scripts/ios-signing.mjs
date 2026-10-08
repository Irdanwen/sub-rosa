/**
 * The pure half of the iOS release lane's signing (ios-release.yml): which
 * bundles the archive carries, what App Store Connect is asked to create for
 * them, when an existing profile is no longer good enough, and what the export
 * is told. `scripts/ios-provision.mjs` does the network and the files; every
 * decision lives here so it can be tested without Apple.
 *
 * Five bundles ship (ADR-0048, ADR-0095): the app, its share extension, its
 * widgets, the watch app and the watch face complication. Only the app is
 * required. A bundle whose profile cannot be obtained is left out of the
 * archive with a warning, so a TestFlight build of the app still goes out.
 */

import { createPrivateKey, sign } from "node:crypto";

export const APP_GROUP = "group.xyz.carpediem.subrosa";

/** The Apple Distribution certificate the lane's .p12 holds (HANDOFF.md §9). */
export const DEFAULT_CERTIFICATE_ID = "Q3722FZBS4";

/**
 * Every bundle of the archive. `name` is the App ID's display name, used only
 * when the lane registers it. `capabilities` are the ones the lane turns on
 * itself; an App Group's association with a bundle is not something the API
 * can make, so `appGroups` is only checked. `parent` is the bundle this one
 * lives inside: leaving the parent out leaves it out too.
 */
export const TARGETS = [
  {
    key: "app",
    bundleId: "xyz.carpediem.subrosa",
    name: "Sub Rosa",
    profileName: "Sub Rosa App Store",
    secret: "IOS_PROVISION_PROFILE",
    required: true,
    // Health, read only (ADR-0099).
    capabilities: ["HEALTHKIT"],
    appGroups: [APP_GROUP],
  },
  {
    key: "share",
    bundleId: "xyz.carpediem.subrosa.share",
    name: "Sub Rosa Share",
    profileName: "Sub Rosa Share App Store",
    secret: "IOS_SHARE_PROVISION_PROFILE",
    capabilities: [],
    appGroups: [APP_GROUP],
  },
  {
    // Buttons that open `subrosa://` addresses: no data, so no App Group.
    key: "widgets",
    bundleId: "xyz.carpediem.subrosa.widgets",
    name: "Sub Rosa Widgets",
    profileName: "Sub Rosa Widgets App Store",
    secret: "IOS_WIDGETS_PROVISION_PROFILE",
    capabilities: [],
    appGroups: [],
  },
  {
    // A watch app is an IOS bundle id in the API, with an iOS App Store profile.
    key: "watch",
    bundleId: "xyz.carpediem.subrosa.watchkitapp",
    name: "Sub Rosa Watch",
    profileName: "Sub Rosa Watch App Store",
    secret: "IOS_WATCH_PROVISION_PROFILE",
    capabilities: [],
    appGroups: [],
  },
  {
    key: "watch-widgets",
    bundleId: "xyz.carpediem.subrosa.watchkitapp.widgets",
    name: "Sub Rosa Watch Widgets",
    profileName: "Sub Rosa Watch Widgets App Store",
    secret: "IOS_WATCH_WIDGETS_PROVISION_PROFILE",
    capabilities: [],
    appGroups: [],
    parent: "watch",
  },
];

/**
 * The entitlement a profile carries once its App ID has a capability. A
 * profile made before the capability was turned on does not have it, which is
 * how a stale profile is recognised. Capabilities missing here are not checked.
 */
export const CAPABILITY_ENTITLEMENTS = {
  APP_GROUPS: "com.apple.security.application-groups",
  ASSOCIATED_DOMAINS: "com.apple.developer.associated-domains",
  HEALTHKIT: "com.apple.developer.healthkit",
};

export function requiredEntitlements(capabilityTypes) {
  return [
    ...new Set(capabilityTypes.map((type) => CAPABILITY_ENTITLEMENTS[type]).filter(Boolean)),
  ].sort();
}

// --- App Store Connect API -------------------------------------------------

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** The ES256 token App Store Connect takes (twenty minutes at most). */
export function apiToken({ keyId, issuer, privateKeyPem, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: issuer, iat, exp: iat + 19 * 60, aud: "appstoreconnect-v1" }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

export function bundleIdPayload(target) {
  return {
    data: {
      type: "bundleIds",
      attributes: { identifier: target.bundleId, name: target.name, platform: "IOS" },
    },
  };
}

export function capabilityPayload(bundleIdResourceId, capabilityType) {
  return {
    data: {
      type: "bundleIdCapabilities",
      attributes: { capabilityType },
      relationships: { bundleId: { data: { type: "bundleIds", id: bundleIdResourceId } } },
    },
  };
}

export function profilePayload({ name, bundleIdResourceId, certificateId }) {
  return {
    data: {
      type: "profiles",
      attributes: { name, profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: bundleIdResourceId } },
        certificates: { data: [{ type: "certificates", id: certificateId }] },
      },
    },
  };
}

/** `filter[identifier]` matches more than one id: the app's matches them all. */
export function exactBundleId(resources, identifier) {
  return resources.find((resource) => resource.attributes?.identifier === identifier) ?? null;
}

/** Capabilities the bundle still lacks, in the order the target lists them. */
export function missingCapabilities(wanted, enabledTypes) {
  return wanted.filter((type) => !enabledTypes.includes(type));
}

export function normalizeSerial(serial) {
  return String(serial ?? "")
    .replace(/^serial=/i, "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase()
    .replace(/^0+(?=.)/, "");
}

/**
 * The distribution certificate whose key the lane imported. The serial read
 * from the keychain wins, because only that certificate can sign; the known id
 * is the fallback when the serial could not be read.
 */
export function pickCertificate(certificates, { id = DEFAULT_CERTIFICATE_ID, serial } = {}) {
  const distribution = certificates.filter((certificate) =>
    ["DISTRIBUTION", "IOS_DISTRIBUTION"].includes(certificate.attributes?.certificateType),
  );
  const wantedSerial = normalizeSerial(serial);
  if (wantedSerial) {
    const bySerial = distribution.find(
      (certificate) => normalizeSerial(certificate.attributes?.serialNumber) === wantedSerial,
    );
    if (bySerial) return bySerial;
  }
  return distribution.find((certificate) => certificate.id === id) ?? null;
}

/**
 * The lane's own profiles for a bundle: its name, or its name plus a suffix
 * when an old one could not be deleted. Xcode-managed profiles are ignored.
 */
export function candidateProfiles(profiles, target, bundleIdResourceId) {
  return profiles
    .filter((profile) => {
      const related = profile.relationships?.bundleId?.data?.id;
      if (related) return related === bundleIdResourceId;
      // No relationship data: read the bundle from the profile itself.
      const content = profile.attributes?.profileContent;
      return (
        Boolean(content) && profileMatchesBundle(parsePlist(profileXml(content)), target.bundleId)
      );
    })
    .filter((profile) => {
      const name = profile.attributes?.name ?? "";
      return name === target.profileName || name.startsWith(`${target.profileName} `);
    })
    .sort((a, b) =>
      String(b.attributes?.createdDate ?? "").localeCompare(
        String(a.attributes?.createdDate ?? ""),
      ),
    );
}

/** A name the team does not use yet (profile names are unique per team). */
export function freshProfileName(base, takenNames, now = new Date()) {
  if (!takenNames.includes(base)) return base;
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `${base} ${stamp}`;
}

// --- Profiles ----------------------------------------------------------------

/** The plist inside a .mobileprovision (a CMS envelope around XML). */
export function profileXml(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "base64");
  const text = buffer.toString("latin1");
  const start = text.indexOf("<?xml");
  const end = text.indexOf("</plist>");
  if (start < 0 || end < 0) throw new Error("Not a provisioning profile: no plist inside.");
  return buffer.subarray(start, end + "</plist>".length).toString("utf8");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : +entity.slice(1);
    return String.fromCodePoint(code);
  });
}

/** Enough of the XML plist format for a profile and an ExportOptions file. */
export function parsePlist(xml) {
  const body = xml
    .replace(/<\?xml[^>]*\?>/, "")
    .replace(/<!DOCTYPE[^>]*>/, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const tokens = [...body.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g)]
    .map(([, close, tag, selfClosing, text]) =>
      tag ? { close: close === "/", tag, empty: selfClosing === "/" } : { text },
    )
    .filter((token) => token.tag || token.text.trim());
  let index = 0;

  function textUntil(tag) {
    let text = "";
    while (index < tokens.length && !(tokens[index].close && tokens[index].tag === tag)) {
      text += tokens[index].text ?? "";
      index += 1;
    }
    index += 1;
    return unescapeXml(text);
  }

  function value() {
    const token = tokens[index++];
    if (!token?.tag) throw new Error("Malformed plist.");
    const { tag, empty } = token;
    switch (tag) {
      case "dict": {
        const dict = {};
        if (empty) return dict;
        while (!(tokens[index].close && tokens[index].tag === "dict")) {
          const key = tokens[index++];
          if (key.tag !== "key") throw new Error("Malformed plist dict.");
          const name = key.empty ? "" : textUntil("key");
          dict[name] = value();
        }
        index += 1;
        return dict;
      }
      case "array": {
        const array = [];
        if (empty) return array;
        while (!(tokens[index].close && tokens[index].tag === "array")) array.push(value());
        index += 1;
        return array;
      }
      case "true":
        return true;
      case "false":
        return false;
      case "string":
      case "date":
      case "data":
        return empty ? "" : textUntil(tag);
      case "integer":
      case "real":
        return Number(textUntil(tag));
      default:
        throw new Error(`Unexpected plist element <${tag}>.`);
    }
  }

  const root = tokens[index++];
  if (root?.tag !== "plist") throw new Error("Not a plist.");
  return value();
}

const DAY = 24 * 60 * 60 * 1000;

function compactBase64(text) {
  return String(text).replace(/\s+/g, "");
}

/**
 * Why a profile cannot sign this bundle, or nothing when it can. The
 * certificate is confirmed by the relationship App Store Connect returns or by
 * the certificates the profile itself embeds. A profile
 * made before a capability was turned on lacks its entitlement, and one made
 * before the bundle joined the App Group lacks the group: both are stale even
 * while Apple still calls them active.
 */
export function profileProblems({
  attributes = {},
  certificateIds = [],
  plist,
  certificateId,
  certificateContent,
  entitlements = [],
  appGroups = [],
  now = Date.now(),
}) {
  const problems = [];
  if (attributes.profileState && attributes.profileState !== "ACTIVE") {
    problems.push({ kind: "state", detail: `profile is ${attributes.profileState}` });
  }
  const expiry = Date.parse(attributes.expirationDate ?? plist?.ExpirationDate ?? "");
  if (Number.isFinite(expiry) && expiry - now < DAY) {
    problems.push({ kind: "expired", detail: "profile expires within a day" });
  }
  if (certificateId || certificateContent) {
    const held = (plist?.DeveloperCertificates ?? []).map(compactBase64);
    const holds =
      (certificateId && certificateIds.includes(certificateId)) ||
      (certificateContent && held.includes(compactBase64(certificateContent)));
    if (!holds) {
      problems.push({
        kind: "certificate",
        detail: `profile does not hold the certificate ${certificateId ?? ""}`.trim(),
      });
    }
  }
  const granted = plist?.Entitlements ?? {};
  for (const key of entitlements) {
    if (!(key in granted)) problems.push({ kind: "entitlement", detail: `missing ${key}` });
  }
  const groups = granted[CAPABILITY_ENTITLEMENTS.APP_GROUPS];
  for (const group of appGroups) {
    if (!Array.isArray(groups) || !groups.includes(group)) {
      problems.push({ kind: "group", detail: `missing the App Group ${group}` });
    }
  }
  return problems;
}

/**
 * A profile just made by the lane is the best it can get: a missing
 * entitlement is reported and the lane goes on (the HealthKit step strips what
 * the profile lacks), but a missing App Group means the portal never
 * associated it, and the bundle would fail the export.
 */
export function fatalForNewProfile(problems) {
  return problems.filter((problem) => problem.kind === "group" || problem.kind === "certificate");
}

/** Whether a profile from a secret belongs to this bundle at all. */
export function profileMatchesBundle(plist, bundleId) {
  // "<team id>.<bundle id>"
  const identifier = plist?.Entitlements?.["application-identifier"] ?? "";
  return identifier.includes(".") && identifier.slice(identifier.indexOf(".") + 1) === bundleId;
}

// --- What ships --------------------------------------------------------------

/**
 * Splits the targets into the bundles that ship and the ones left out, given
 * the profile obtained for each (or null). A bundle inside a dropped one is
 * dropped with it. The app has no fallback: without it there is no build.
 */
export function planTargets(targets, profiles) {
  const kept = [];
  const dropped = [];
  for (const target of targets) {
    const profile = profiles[target.key] ?? null;
    const parentDropped = target.parent && dropped.some((entry) => entry.key === target.parent);
    if (parentDropped) {
      dropped.push({ ...target, reason: `inside ${target.parent}, which is left out` });
    } else if (!profile) {
      dropped.push({ ...target, reason: "no App Store profile" });
    } else {
      kept.push({ ...target, profile });
    }
  }
  const appMissing = targets.some(
    (target) => target.required && dropped.some((entry) => entry.key === target.key),
  );
  return { kept, dropped, appMissing };
}

/**
 * The ExportOptions for `xcodebuild -exportArchive`. Profiles made by the
 * lane (or the portal) map each bundle to its profile by name under manual
 * signing. Xcode refuses an Xcode-managed profile under manual signing even
 * with the right certificate, so a managed one (only ever from an old secret)
 * switches the export to automatic selection.
 */
export function exportOptions({ teamId, kept }) {
  const managed = kept.some((entry) => entry.profile.managed);
  const options = {
    method: "app-store-connect",
    destination: "export",
    signingStyle: managed ? "automatic" : "manual",
    teamID: teamId,
    manageAppVersionAndBuildNumber: false,
  };
  if (!managed) {
    options.signingCertificate = "Apple Distribution";
    options.provisioningProfiles = Object.fromEntries(
      kept.map((entry) => [entry.bundleId, entry.profile.name]),
    );
  }
  return options;
}

/** Managed and portal profiles together cannot export in either style. */
export function mixedSigning(kept) {
  const managed = kept.filter((entry) => entry.profile.managed).length;
  return managed > 0 && managed < kept.length;
}

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistValue(value, indent) {
  const pad = "\t".repeat(indent);
  if (value === true) return `${pad}<true/>`;
  if (value === false) return `${pad}<false/>`;
  if (typeof value === "number" && Number.isInteger(value))
    return `${pad}<integer>${value}</integer>`;
  if (typeof value === "string") return `${pad}<string>${escapeXml(value)}</string>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<array/>`;
    return [
      `${pad}<array>`,
      ...value.map((item) => plistValue(item, indent + 1)),
      `${pad}</array>`,
    ].join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}<dict/>`;
    return [
      `${pad}<dict>`,
      ...entries.flatMap(([key, item]) => [
        `${pad}\t<key>${escapeXml(key)}</key>`,
        plistValue(item, indent + 1),
      ]),
      `${pad}</dict>`,
    ].join("\n");
  }
  throw new Error(`Cannot write ${typeof value} to a plist.`);
}

export function renderPlist(value) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(value, 0),
    "</plist>",
    "",
  ].join("\n");
}
