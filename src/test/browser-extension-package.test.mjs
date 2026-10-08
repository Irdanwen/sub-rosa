import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  chromiumManifest,
  firefoxManifest,
  popupHtml,
} from "../../browser-extension/scripts/flavors.mjs";
import { crc32, zip } from "../../browser-extension/scripts/zip.mjs";

const root = join(__dirname, "../../browser-extension");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const locales = Object.fromEntries(
  ["en", "fr"].map((lang) => [
    lang,
    JSON.parse(readFileSync(join(root, "_locales", lang, "messages.json"), "utf8")),
  ]),
);

describe("the extension manifest", () => {
  it("asks for no standing access to any site", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.permissions).not.toContain("<all_urls>");
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["activeTab", "scripting", "nativeMessaging"]),
    );
  });

  it("keeps its version in step with the package", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.version).toBe(pkg.version);
  });

  it("gives the stores a Chromium build without the key and Firefox its own shape", () => {
    const unpacked = chromiumManifest(manifest);
    expect(unpacked.key).toBe(manifest.key);
    expect(unpacked.browser_specific_settings).toBeUndefined();
    expect(chromiumManifest(manifest, { forStore: true }).key).toBeUndefined();

    const firefox = firefoxManifest(manifest);
    expect(firefox.key).toBeUndefined();
    expect(firefox.side_panel).toBeUndefined();
    expect(firefox.permissions).not.toContain("sidePanel");
    expect(firefox.background).toEqual({ scripts: ["src/background.js"], type: "module" });
    expect(firefox.sidebar_action.default_panel).toBe("src/panel.html");
    expect(firefox.browser_specific_settings.gecko.id).toBe(
      "browser-extension@subrosa.carpediem.xyz",
    );
    // The source is never changed by a flavour.
    expect(manifest.side_panel).toBeDefined();
  });

  it("makes the popup from the panel", () => {
    const panel = readFileSync(join(root, "src/panel.html"), "utf8");
    expect(popupHtml(panel)).toContain('data-surface="popup"');
    expect(popupHtml(panel)).not.toContain('data-surface="panel"');
  });
});

describe("the panel's views", () => {
  // The panel switches views with the `hidden` attribute. A block that sets
  // its own `display` beats the user agent's `[hidden]` rule, and a real
  // browser run showed the main view under the pairing form.
  it("hides a hidden block whatever display it sets", () => {
    const css = readFileSync(join(root, "src/panel.css"), "utf8");
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
    const html = readFileSync(join(root, "src/panel.html"), "utf8");
    for (const id of ["notice", "pair", "main", "stage", "selection", "open-panel", "stop"]) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*\\shidden`));
    }
  });
});

describe("the extension's languages", () => {
  const sourceFiles = readdirSync(join(root, "src")).map((name) =>
    readFileSync(join(root, "src", name), "utf8"),
  );

  it("has the same messages and placeholders in English and French", () => {
    expect(Object.keys(locales.fr).sort()).toEqual(Object.keys(locales.en).sort());
    for (const [key, entry] of Object.entries(locales.en)) {
      expect(Object.keys(locales.fr[key].placeholders ?? {}), key).toEqual(
        Object.keys(entry.placeholders ?? {}),
      );
      expect(locales.fr[key].message.trim(), key).not.toBe("");
    }
  });

  it("uses no typographic dashes", () => {
    for (const lang of ["en", "fr"]) {
      for (const entry of Object.values(locales[lang])) {
        expect(entry.message).not.toMatch(/[–—]/);
      }
    }
  });

  it("names only messages the catalog has", () => {
    const used = new Set();
    for (const source of sourceFiles) {
      for (const match of source.matchAll(/data-i18n(?:-placeholder)?="([A-Za-z]+)"/g)) {
        used.add(match[1]);
      }
      for (const match of source.matchAll(/\bmsg\("([A-Za-z]+)"/g)) used.add(match[1]);
      for (const match of source.matchAll(/getMessage\("([A-Za-z]+)"/g)) used.add(match[1]);
    }
    for (const match of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z]+)__/g)) {
      used.add(match[1]);
    }
    expect(used.size).toBeGreaterThan(20);
    for (const key of used) expect(locales.en[key], key).toBeDefined();
  });
});

describe("the store zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("writes entries a reader can find and inflate", () => {
    const archive = zip([
      { name: "b/two.txt", data: Buffer.from("second") },
      { name: "a.txt", data: Buffer.from("first ".repeat(50)) },
    ]);
    const end = archive.length - 22;
    expect(archive.readUInt32LE(end)).toBe(0x06054b50);
    expect(archive.readUInt16LE(end + 10)).toBe(2);
    // The first local entry is the first name in order, and inflates back.
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    const nameLength = archive.readUInt16LE(26);
    const size = archive.readUInt32LE(18);
    expect(archive.subarray(30, 30 + nameLength).toString()).toBe("a.txt");
    const body = inflateRawSync(archive.subarray(30 + nameLength, 30 + nameLength + size));
    expect(body.toString()).toBe("first ".repeat(50));
    expect(archive.readUInt32LE(14)).toBe(crc32(body));
  });
});
