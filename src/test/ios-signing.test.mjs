import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_GROUP,
  apiPaths,
  apiToken,
  bundleIdPayload,
  candidateProfiles,
  capabilityPayload,
  exactBundleId,
  exportOptions,
  fatalForNewProfile,
  freshProfileName,
  missingCapabilities,
  mixedSigning,
  normalizeSerial,
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
} from "../../scripts/ios-signing.mjs";

/**
 * The iOS release lane gets its own App Store profiles through the App Store
 * Connect API (scripts/ios-provision.mjs). Only a real run talks to Apple, so
 * every decision it makes on the way is pinned here.
 */

const target = (key) => TARGETS.find((entry) => entry.key === key);
const CERT = "Q3722FZBS4";
const CERT_DER = "MIIFAKECERTIFICATE";

function profilePlist({
  bundleId = "xyz.carpediem.subrosa",
  entitlements = {},
  managed = false,
  certificates = [CERT_DER],
  name = "Sub Rosa App Store",
} = {}) {
  const extra = Object.entries(entitlements)
    .map(([key, value]) => {
      if (value === true) return `<key>${key}</key><true/>`;
      if (Array.isArray(value)) {
        return `<key>${key}</key><array>${value.map((item) => `<string>${item}</string>`).join("")}</array>`;
      }
      return `<key>${key}</key><string>${value}</string>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AppIDName</key><string>Sub Rosa &amp; co</string>
  <key>DeveloperCertificates</key>
  <array>${certificates.map((der) => `<data>\n\t${der}\n\t</data>`).join("")}</array>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>H6N5V777LL.${bundleId}</string>
    <key>get-task-allow</key><false/>
    ${extra}
  </dict>
  <key>ExpirationDate</key><date>2027-02-01T00:00:00Z</date>
  <key>IsXcodeManaged</key>${managed ? "<true/>" : "<false/>"}
  <key>Name</key><string>${name}</string>
  <key>TimeToLive</key><integer>365</integer>
  <key>UUID</key><string>274f93e9-0000-4000-8000-000000000000</string>
  <key>ProvisionsAllDevices</key><false/>
  <key>Empty</key><array/>
</dict>
</plist>`;
}

/** A .mobileprovision is a CMS envelope with the plist in the middle. */
function envelope(xml) {
  return Buffer.concat([
    Buffer.from([0x30, 0x80, 0x06, 0x09, 0x2a, 0x86]),
    Buffer.from(xml),
    Buffer.from([0x00, 0x00, 0xa0, 0x82]),
  ]).toString("base64");
}

describe("the bundles the lane signs", () => {
  it("are the five targets of the committed project, the app the only required one", () => {
    expect(TARGETS.map((entry) => entry.bundleId)).toEqual([
      "xyz.carpediem.subrosa",
      "xyz.carpediem.subrosa.share",
      "xyz.carpediem.subrosa.widgets",
      "xyz.carpediem.subrosa.watchkitapp",
      "xyz.carpediem.subrosa.watchkitapp.widgets",
    ]);
    expect(TARGETS.filter((entry) => entry.required).map((entry) => entry.key)).toEqual(["app"]);
    const spec = readFileSync("src-tauri/gen/apple/project.yml", "utf8");
    for (const entry of TARGETS) {
      expect(spec).toContain(`PRODUCT_BUNDLE_IDENTIFIER: ${entry.bundleId}\n`);
    }
  });

  it("check the App Group exactly where the entitlements files claim it", () => {
    const claims = (path) => readFileSync(path, "utf8").includes(`<string>${APP_GROUP}</string>`);
    expect(target("app").appGroups).toEqual(
      claims("src-tauri/gen/apple/os-june_iOS/os-june_iOS.entitlements") ? [APP_GROUP] : [],
    );
    expect(target("share").appGroups).toEqual(
      claims("src-tauri/gen/apple/ShareExtension/ShareExtension.entitlements") ? [APP_GROUP] : [],
    );
    for (const key of ["widgets", "watch", "watch-widgets"]) {
      expect(target(key).appGroups).toEqual([]);
    }
  });

  it("turn HealthKit on for the app, whose entitlements ask for it", () => {
    const app = readFileSync("src-tauri/gen/apple/os-june_iOS/os-june_iOS.entitlements", "utf8");
    expect(app).toContain("<key>com.apple.developer.healthkit</key>");
    expect(target("app").capabilities).toEqual(["HEALTHKIT"]);
  });

  it("carry distinct profile names and secrets", () => {
    expect(new Set(TARGETS.map((entry) => entry.profileName)).size).toBe(TARGETS.length);
    expect(new Set(TARGETS.map((entry) => entry.secret)).size).toBe(TARGETS.length);
  });
});

describe("App Store Connect requests", () => {
  it("sign an ES256 token App Store Connect accepts", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const token = apiToken({
      keyId: "2X9R4HXF34",
      issuer: "issuer",
      privateKeyPem: pem,
      now: 1e12,
    });
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "2X9R4HXF34",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toEqual({
      iss: "issuer",
      iat: 1e9,
      exp: 1e9 + 19 * 60,
      aud: "appstoreconnect-v1",
    });
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  // Run 37847393168: `bundleIdCapabilities?limit=200` answered 400 for every
  // bundle, so each one fell back to its secret or was left out.
  it("page the top-level lists, never a relationship", () => {
    expect(apiPaths.bundleIdCapabilities("8F3PFQ92WM")).toBe(
      "bundleIds/8F3PFQ92WM/bundleIdCapabilities",
    );
    expect(apiPaths.profile("ABC123")).toBe("profiles/ABC123");
    const lists = [
      apiPaths.bundleIds("xyz.carpediem.subrosa"),
      apiPaths.distributionCertificates(),
      apiPaths.appStoreProfiles(),
    ];
    for (const path of lists) {
      const [resource, query] = path.split("?");
      expect(resource, path).toMatch(/^(bundleIds|certificates|profiles)$/);
      expect(new URLSearchParams(query).get("limit"), path).toBe("200");
    }
    expect(apiPaths.bundleIds("xyz.carpediem.subrosa")).toContain(
      "filter[identifier]=xyz.carpediem.subrosa&",
    );
  });

  it("reach App Store Connect only through those paths", () => {
    const script = readFileSync("scripts/ios-provision.mjs", "utf8");
    const literalQueries = [...script.matchAll(/call\(\s*[`"][^`"]*\?/g)];
    expect(literalQueries.map((match) => match[0])).toEqual([]);
    expect(script).not.toMatch(/bundleIdCapabilities\?/);
  });

  it("register a watch bundle id as an IOS one", () => {
    expect(bundleIdPayload(target("watch"))).toEqual({
      data: {
        type: "bundleIds",
        attributes: {
          identifier: "xyz.carpediem.subrosa.watchkitapp",
          name: "Sub Rosa Watch",
          platform: "IOS",
        },
      },
    });
  });

  it("turn a capability on for a bundle id resource", () => {
    expect(capabilityPayload("8F3PFQ92WM", "HEALTHKIT")).toEqual({
      data: {
        type: "bundleIdCapabilities",
        attributes: { capabilityType: "HEALTHKIT" },
        relationships: { bundleId: { data: { type: "bundleIds", id: "8F3PFQ92WM" } } },
      },
    });
  });

  it("ask for an App Store profile signed by the distribution certificate", () => {
    expect(
      profilePayload({
        name: "Sub Rosa App Store",
        bundleIdResourceId: "8F3PFQ92WM",
        certificateId: CERT,
      }),
    ).toEqual({
      data: {
        type: "profiles",
        attributes: { name: "Sub Rosa App Store", profileType: "IOS_APP_STORE" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: "8F3PFQ92WM" } },
          certificates: { data: [{ type: "certificates", id: CERT }] },
        },
      },
    });
  });

  it("pick the exact bundle id out of a prefix match", () => {
    const listed = [
      { id: "WV6Q54434R", attributes: { identifier: "xyz.carpediem.subrosa.share" } },
      { id: "8F3PFQ92WM", attributes: { identifier: "xyz.carpediem.subrosa" } },
    ];
    expect(exactBundleId(listed, "xyz.carpediem.subrosa")?.id).toBe("8F3PFQ92WM");
    expect(exactBundleId(listed, "xyz.carpediem.subrosa.widgets")).toBeNull();
  });

  it("only add the capabilities a bundle lacks", () => {
    expect(missingCapabilities(["HEALTHKIT"], ["APP_GROUPS", "ASSOCIATED_DOMAINS"])).toEqual([
      "HEALTHKIT",
    ]);
    expect(missingCapabilities(["HEALTHKIT"], ["HEALTHKIT"])).toEqual([]);
  });

  it("require the entitlements of the capabilities the bundle has", () => {
    expect(
      requiredEntitlements(["HEALTHKIT", "APP_GROUPS", "IN_APP_PURCHASE", "HEALTHKIT"]),
    ).toEqual(["com.apple.developer.healthkit", "com.apple.security.application-groups"]);
  });
});

describe("the distribution certificate", () => {
  const certificates = [
    { id: "DEVCERT001", attributes: { certificateType: "DEVELOPMENT", serialNumber: "7A3B" } },
    { id: "OTHERDIST1", attributes: { certificateType: "DISTRIBUTION", serialNumber: "1234" } },
    { id: CERT, attributes: { certificateType: "DISTRIBUTION", serialNumber: "7A3B" } },
  ];

  it("is the one whose serial the keychain holds", () => {
    expect(normalizeSerial("serial=007A:3b")).toBe("7A3B");
    expect(pickCertificate(certificates, { id: "OTHERDIST1", serial: "serial=7A3B" })?.id).toBe(
      CERT,
    );
  });

  it("falls back to the known id, never to a development certificate", () => {
    expect(pickCertificate(certificates, { serial: "" })?.id).toBe(CERT);
    expect(pickCertificate(certificates, { id: "DEVCERT001" })).toBeNull();
  });
});

describe("reading a profile", () => {
  it("finds the plist inside the CMS envelope and parses it", () => {
    const xml = profileXml(envelope(profilePlist({ entitlements: { "x.groups": [APP_GROUP] } })));
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml.endsWith("</plist>")).toBe(true);
    const plist = parsePlist(xml);
    expect(plist.Name).toBe("Sub Rosa App Store");
    expect(plist.AppIDName).toBe("Sub Rosa & co");
    expect(plist.TimeToLive).toBe(365);
    expect(plist.IsXcodeManaged).toBe(false);
    expect(plist.Empty).toEqual([]);
    expect(plist.Entitlements["get-task-allow"]).toBe(false);
    expect(plist.Entitlements["x.groups"]).toEqual([APP_GROUP]);
    expect(plist.DeveloperCertificates[0].replace(/\s+/g, "")).toBe(CERT_DER);
  });

  it("refuses something that is not a profile", () => {
    expect(() => profileXml(Buffer.from("nothing here"))).toThrow(/Not a provisioning profile/);
  });

  it("belongs to exactly one bundle", () => {
    const plist = parsePlist(
      profilePlist({ bundleId: "xyz.carpediem.subrosa.watchkitapp.widgets" }),
    );
    expect(profileMatchesBundle(plist, "xyz.carpediem.subrosa.watchkitapp.widgets")).toBe(true);
    expect(profileMatchesBundle(plist, "xyz.carpediem.subrosa.widgets")).toBe(false);
    expect(profileMatchesBundle(plist, "xyz.carpediem.subrosa")).toBe(false);
  });
});

describe("a stale profile", () => {
  const now = Date.parse("2026-10-08T00:00:00Z");
  const fresh = {
    attributes: { profileState: "ACTIVE", expirationDate: "2027-02-01T00:00:00Z" },
    certificateIds: [CERT],
    certificateId: CERT,
    now,
  };

  it("is not one that carries what the bundle now has", () => {
    const plist = parsePlist(
      profilePlist({
        entitlements: {
          "com.apple.developer.healthkit": true,
          "com.apple.security.application-groups": [APP_GROUP],
        },
      }),
    );
    expect(
      profileProblems({
        ...fresh,
        plist,
        entitlements: requiredEntitlements(["HEALTHKIT", "APP_GROUPS"]),
        appGroups: [APP_GROUP],
      }),
    ).toEqual([]);
  });

  it("is one made before HealthKit was turned on", () => {
    const plist = parsePlist(
      profilePlist({ entitlements: { "com.apple.security.application-groups": [APP_GROUP] } }),
    );
    expect(
      profileProblems({ ...fresh, plist, entitlements: requiredEntitlements(["HEALTHKIT"]) }),
    ).toEqual([{ kind: "entitlement", detail: "missing com.apple.developer.healthkit" }]);
  });

  it("is one Apple invalidated, one about to expire, or one for another certificate", () => {
    const plist = parsePlist(profilePlist({ certificates: ["MIIOTHER"] }));
    const problems = profileProblems({
      attributes: { profileState: "INVALID", expirationDate: "2026-10-08T12:00:00Z" },
      certificateIds: ["OTHERDIST1"],
      certificateId: CERT,
      certificateContent: CERT_DER,
      plist,
      now,
    });
    expect(problems.map((problem) => problem.kind)).toEqual(["state", "expired", "certificate"]);
  });

  it("holds the certificate when the profile embeds it, even without relationship data", () => {
    const plist = parsePlist(profilePlist());
    expect(
      profileProblems({ plist, certificateId: CERT, certificateContent: CERT_DER, now }),
    ).toEqual([]);
  });

  it("lacking the App Group is fatal only for a profile the lane just made", () => {
    const plist = parsePlist(profilePlist());
    const problems = profileProblems({
      ...fresh,
      plist,
      entitlements: ["com.apple.developer.healthkit"],
      appGroups: [APP_GROUP],
    });
    expect(problems.map((problem) => problem.kind)).toEqual(["entitlement", "group"]);
    expect(fatalForNewProfile(problems).map((problem) => problem.kind)).toEqual(["group"]);
  });
});

describe("finding the lane's own profiles", () => {
  const share = target("share");
  const profiles = [
    {
      id: "K69686224N",
      attributes: { name: "Sub Rosa Share App Store", createdDate: "2026-09-27T00:00:00Z" },
      relationships: { bundleId: { data: { type: "bundleIds", id: "WV6Q54434R" } } },
    },
    {
      id: "NEWERONE01",
      attributes: {
        name: "Sub Rosa Share App Store 202610080930",
        createdDate: "2026-10-08T09:30:00Z",
      },
      relationships: { bundleId: { data: { type: "bundleIds", id: "WV6Q54434R" } } },
    },
    {
      id: "MANAGED001",
      attributes: { name: "iOS Team Store Provisioning Profile: xyz.carpediem.subrosa.share" },
      relationships: { bundleId: { data: { type: "bundleIds", id: "WV6Q54434R" } } },
    },
    {
      id: "L22APT9924",
      attributes: { name: "Sub Rosa App Store", createdDate: "2026-09-27T00:00:00Z" },
      relationships: { bundleId: { data: { type: "bundleIds", id: "8F3PFQ92WM" } } },
    },
    {
      id: "NORELATION",
      attributes: {
        name: "Sub Rosa Share App Store",
        profileContent: envelope(profilePlist({ bundleId: "xyz.carpediem.subrosa.share" })),
      },
    },
  ];

  it("are named after the bundle, newest first, never Xcode's", () => {
    expect(candidateProfiles(profiles, share, "WV6Q54434R").map((profile) => profile.id)).toEqual([
      "NEWERONE01",
      "K69686224N",
      "NORELATION",
    ]);
  });

  it("take a new name only when an old one could not be deleted", () => {
    const now = new Date("2026-10-08T09:30:00Z");
    expect(freshProfileName("Sub Rosa App Store", [], now)).toBe("Sub Rosa App Store");
    expect(freshProfileName("Sub Rosa App Store", ["Sub Rosa App Store"], now)).toBe(
      "Sub Rosa App Store 202610080930",
    );
  });
});

describe("what ships", () => {
  const profile = (name, managed = false) => ({ name, uuid: `${name}-uuid`, managed });

  it("everything, when every bundle has its profile", () => {
    const plan = planTargets(
      TARGETS,
      Object.fromEntries(TARGETS.map((entry) => [entry.key, profile(entry.profileName)])),
    );
    expect(plan.kept).toHaveLength(5);
    expect(plan.dropped).toEqual([]);
    expect(plan.appMissing).toBe(false);
  });

  it("the app without the watch, whose complication goes with it", () => {
    const plan = planTargets(TARGETS, {
      app: profile("Sub Rosa App Store"),
      share: profile("Sub Rosa Share App Store"),
      widgets: profile("Sub Rosa Widgets App Store"),
      watch: null,
      "watch-widgets": profile("Sub Rosa Watch Widgets App Store"),
    });
    expect(plan.kept.map((entry) => entry.key)).toEqual(["app", "share", "widgets"]);
    expect(plan.dropped.map(({ key, reason }) => [key, reason])).toEqual([
      ["watch", "no App Store profile"],
      ["watch-widgets", "inside watch, which is left out"],
    ]);
    expect(plan.appMissing).toBe(false);
  });

  it("nothing, without the app", () => {
    expect(planTargets(TARGETS, { share: profile("Sub Rosa Share App Store") }).appMissing).toBe(
      true,
    );
  });
});

describe("the export options", () => {
  const kept = [
    { bundleId: "xyz.carpediem.subrosa", profile: { name: "Sub Rosa App Store", managed: false } },
    {
      bundleId: "xyz.carpediem.subrosa.widgets",
      profile: { name: "Sub Rosa Widgets App Store", managed: false },
    },
  ];

  it("map each kept bundle to its profile by name under manual signing", () => {
    expect(exportOptions({ teamId: "H6N5V777LL", kept })).toEqual({
      method: "app-store-connect",
      destination: "export",
      signingStyle: "manual",
      teamID: "H6N5V777LL",
      manageAppVersionAndBuildNumber: false,
      signingCertificate: "Apple Distribution",
      provisioningProfiles: {
        "xyz.carpediem.subrosa": "Sub Rosa App Store",
        "xyz.carpediem.subrosa.widgets": "Sub Rosa Widgets App Store",
      },
    });
    expect(mixedSigning(kept)).toBe(false);
  });

  it("let Xcode select an Xcode-managed profile from an old secret", () => {
    const managed = kept.map((entry) => ({
      ...entry,
      profile: { ...entry.profile, managed: true },
    }));
    const options = exportOptions({ teamId: "H6N5V777LL", kept: managed });
    expect(options.signingStyle).toBe("automatic");
    expect(options).not.toHaveProperty("provisioningProfiles");
    expect(mixedSigning([kept[0], managed[1]])).toBe(true);
  });

  it("render as a plist that reads back the same", () => {
    const options = exportOptions({ teamId: "H6N5V777LL", kept });
    const xml = renderPlist(options);
    expect(xml).toContain('<plist version="1.0">');
    expect(xml).toContain("<key>manageAppVersionAndBuildNumber</key>\n\t<false/>");
    expect(parsePlist(xml)).toEqual(options);
    expect(parsePlist(renderPlist({ odd: "a < b & c", list: [], none: {} }))).toEqual({
      odd: "a < b & c",
      list: [],
      none: {},
    });
  });
});
