// @ts-expect-error node:fs is available in the Vitest runtime.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ORIGIN,
  HOSTS,
  manifest,
  PRODUCTION_ORIGIN,
  VERSION,
  // @ts-expect-error a plain script module, typed by its use here.
} from "../../office-addins/scripts/manifests.mjs";

interface Host {
  file: string;
  page: string;
  id: string;
  host: string;
  name: string;
}
const hosts = HOSTS as Host[];
const OFFICE_NS = "http://schemas.microsoft.com/office/appforoffice/1.1";
const BT_NS = "http://schemas.microsoft.com/office/officeappbasictypes/1.0";
const OVERRIDES_NS = "http://schemas.microsoft.com/office/taskpaneappversionoverrides";

/** The order `OfficeApp` children must follow in the TaskPaneApp schema
 * (`offappmanifest-1.1.xsd`), the optional ones included. */
const SEQUENCE = [
  "Id",
  "AlternateId",
  "Version",
  "ProviderName",
  "DefaultLocale",
  "DisplayName",
  "Description",
  "IconUrl",
  "HighResolutionIconUrl",
  "SupportUrl",
  "AppDomains",
  "Hosts",
  "Requirements",
  "DefaultSettings",
  "Permissions",
  "VersionOverrides",
];

function parse(xml: string): Document {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  expect(document.getElementsByTagName("parsererror")).toHaveLength(0);
  return document;
}

describe("the Office add-in manifests", () => {
  it("are committed as the script writes them", () => {
    for (const entry of hosts)
      expect(readFileSync(`office-addins/manifests/${entry.file}`, "utf8"), entry.file).toBe(
        manifest(entry, PRODUCTION_ORIGIN),
      );
  });

  it("follow the schema's order and its required elements", () => {
    for (const entry of hosts) {
      const document = parse(manifest(entry));
      const root = document.documentElement;
      expect(root.namespaceURI).toBe(OFFICE_NS);
      expect(root.getAttributeNS("http://www.w3.org/2001/XMLSchema-instance", "type")).toBe(
        "TaskPaneApp",
      );
      const children = [...root.children].map((child) => child.localName);
      const positions = children.map((name) => SEQUENCE.indexOf(name));
      expect(
        positions.every((position) => position >= 0),
        entry.file,
      ).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      for (const required of ["Id", "Version", "ProviderName", "DefaultLocale", "DisplayName"])
        expect(children, `${entry.file} ${required}`).toContain(required);
      expect(root.getElementsByTagName("Id")[0].textContent).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(root.getElementsByTagName("Version")[0].textContent).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(root.getElementsByTagName("Permissions")[0].textContent).toBe("ReadWriteDocument");
      const host = root.getElementsByTagName("Host")[0];
      expect(host.getAttribute("Name")).toBe(entry.host);
    }
  });

  it("give each host its own id and its own page", () => {
    expect(new Set(hosts.map((entry) => entry.id)).size).toBe(hosts.length);
    expect(hosts.map((entry) => entry.host).sort()).toEqual([
      "Document",
      "Presentation",
      "Workbook",
    ]);
  });

  it("serve the panes from the add-ins' own origin, never the account's", () => {
    expect(PRODUCTION_ORIGIN).toBe("https://office.subrosa.furetier.com");
    expect(ACCOUNT_ORIGIN).toBe("https://subrosa.furetier.com");
    expect(VERSION).toBe("1.0.1.0");
    for (const entry of hosts) {
      const root = parse(manifest(entry)).documentElement;
      // The sign-in window goes to the account origin to sign in.
      const domains = [...root.getElementsByTagName("AppDomain")].map((d) => d.textContent);
      expect(domains, entry.file).toEqual([ACCOUNT_ORIGIN]);
      expect(root.getElementsByTagName("SupportUrl")[0].getAttribute("DefaultValue")).toBe(
        `${ACCOUNT_ORIGIN}/help`,
      );
    }
    expect(() => manifest(hosts[0], ACCOUNT_ORIGIN, ACCOUNT_ORIGIN)).toThrow();
  });

  it("name only HTTPS URLs on the office origin, served by the build", () => {
    for (const entry of hosts) {
      const xml = manifest(entry).replace(/<SupportUrl [^>]+>/, "");
      const urls = [...xml.matchAll(/(?:DefaultValue|Value)="(https?:[^"]+)"/g)].map((m) => m[1]);
      expect(urls.length, entry.file).toBeGreaterThan(5);
      for (const url of urls) expect(new URL(url).origin, url).toBe(PRODUCTION_ORIGIN);
      for (const url of urls) {
        const path = new URL(url).pathname;
        if (path.startsWith("/office/icon-"))
          expect(existsSync(`office-addins/public${path}`), path).toBe(true);
        else if (path.startsWith("/office/"))
          expect(existsSync(`office-addins${path}`), path).toBe(true);
      }
    }
  });

  it("define every resource they refer to, within Office's length limits", () => {
    for (const entry of hosts) {
      const document = parse(manifest(entry));
      const overrides = document.getElementsByTagNameNS(OVERRIDES_NS, "VersionOverrides")[0];
      expect(overrides).toBeTruthy();
      const defined = new Set(
        [...document.getElementsByTagNameNS(BT_NS, "*")]
          .map((element) => element.getAttribute("id"))
          .filter(Boolean),
      );
      const used = [...document.querySelectorAll("[resid]")].map((element) =>
        element.getAttribute("resid"),
      );
      for (const resid of used) expect(defined.has(resid), `${entry.file} ${resid}`).toBe(true);
      const short = document.getElementsByTagNameNS(BT_NS, "ShortStrings")[0];
      for (const string of [...short.getElementsByTagNameNS(BT_NS, "String")])
        expect(string.getAttribute("DefaultValue")?.length ?? 0).toBeLessThanOrEqual(125);
      const description = document.getElementsByTagName("Description")[0];
      expect(description.getAttribute("DefaultValue")?.length ?? 0).toBeLessThanOrEqual(250);
      for (const override of [...description.getElementsByTagName("Override")])
        expect(override.getAttribute("Value")?.length ?? 0).toBeLessThanOrEqual(250);
      const display = document.getElementsByTagName("DisplayName")[0];
      expect(display.getAttribute("DefaultValue")?.length ?? 0).toBeLessThanOrEqual(125);
      const action = document.getElementsByTagNameNS(OVERRIDES_NS, "Action")[0];
      expect(action.getElementsByTagNameNS(OVERRIDES_NS, "TaskpaneId")[0]?.textContent).toBe(
        "SubRosa.Pane",
      );
    }
  });

  it("refuse an origin that is not HTTPS", () => {
    expect(() => manifest(hosts[0], "http://localhost:1431")).toThrow();
    expect(() => manifest(hosts[0], "https://localhost:1431", "http://localhost:1430")).toThrow();
    const dev = manifest(hosts[0], "https://localhost:1431", "https://localhost:1430");
    expect(dev).toContain("https://localhost:1431/office/word.html");
    expect(dev).toContain("<AppDomain>https://localhost:1430</AppDomain>");
  });
});

describe("the task pane pages", () => {
  it("load Office.js from Microsoft's CDN only, in its Trusted Types mode", () => {
    for (const page of ["word", "excel", "powerpoint", "session", "commands"]) {
      const html = readFileSync(`office-addins/office/${page}.html`, "utf8") as string;
      const foreign = [...html.matchAll(/<script[^>]*src="(https?:[^"]+)"[^>]*>/g)];
      expect(
        foreign.map((m) => m[1]),
        page,
      ).toEqual(["https://appsforoffice.microsoft.com/lib/1/hosted/office.js"]);
      expect(foreign[0][0], page).toContain('data-enable-trusted-types="1"');
      expect(html, page).not.toMatch(/<script>(?!<\/script>)/);
    }
  });
});
