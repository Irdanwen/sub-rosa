/**
 * The link gate, asserted as a property rather than as examples.
 *
 * Three things are proven here, over one corpus:
 *  1. `safeExternalUrl` accepts exactly what `open_url.rs` accepts;
 *  2. BOTH markdown renderers agree with it — the desktop one in
 *     AgentWorkspace and the shared `SimpleMarkdown` used by the mobile chat,
 *     the note summary panel and chat blocks;
 *  3. no module outside `src/lib/tauri.ts` calls `window.open`, so the gate
 *     cannot be walked around.
 *
 * The corpus is the point: adding a renderer means adding it to
 * `RENDERERS` below, and it is then held to the same rules for free.
 */

import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

import { renderInlineMarkdown } from "../components/agent/AgentWorkspace";
import {
  ALLOWED_OPEN_SCHEMES,
  MAX_EXTERNAL_URL_LEN,
  isSafeExternalUrl,
  safeExternalHref,
  safeExternalUrl,
} from "../lib/external-link";
import { SimpleMarkdown } from "../lib/simple-markdown";

// Read through `import.meta.glob` rather than `node:fs`: the frontend tsconfig
// carries no Node types, and this is the seam Vite gives a test that needs to
// look at the code rather than run it (see error-message-shape.test.ts).
const SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

/** Hrefs no renderer may turn into an anchor, and no code may open. */
const REJECTED = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "  javascript:alert(1)  ",
  "java\tscript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "http://example.com",
  "http://127.0.0.1:8080/admin",
  "ftp://example.com/f",
  "subrosa://note/1",
  "tel:+15551234567",
  "mailto:someone@example.com",
  "itms-services://?action=download-manifest",
  "https://",
  "//example.com",
  "example.com",
  "https://exa mple.com",
  "https://example.com/\u0007",
  "https://example.com/\u0000",
  "https://user:secret@example.com",
  "",
  "   ",
];

/** Hrefs that are genuinely openable. */
const ACCEPTED = [
  "https://example.com",
  "https://example.com/page?q=1#frag",
  "HTTPS://Example.com/Path",
  "  https://example.com/padded  ",
  "https://sub.domain.example.co.uk/a/b",
  "https://example.com:8443/port",
  // WHATWG resolves the empty authority to host "path"; `open_url.rs` agrees.
  "https:///path",
];

describe("safeExternalUrl", () => {
  it("allows https and nothing else", () => {
    expect([...ALLOWED_OPEN_SCHEMES]).toEqual(["https:"]);
  });

  it("rejects every unsafe href in the corpus", () => {
    for (const href of REJECTED) {
      expect(safeExternalUrl(href), `should reject ${JSON.stringify(href)}`).toBeNull();
      expect(isSafeExternalUrl(href)).toBe(false);
    }
  });

  it("accepts ordinary https URLs and normalizes them", () => {
    for (const href of ACCEPTED) {
      const parsed = safeExternalUrl(href);
      expect(parsed, `should accept ${JSON.stringify(href)}`).not.toBeNull();
      expect(parsed?.protocol).toBe("https:");
    }
    // Normalization is what Rust sees, so it is part of the contract.
    expect(safeExternalHref("HTTPS://Example.com")).toBe("https://example.com/");
  });

  it("punycodes a homoglyph host instead of passing it through", () => {
    // U+0430 CYRILLIC SMALL LETTER A, not ASCII "a".
    const href = safeExternalHref("https://\u0430pple.com/signin");
    expect(href).toBe("https://xn--pple-43d.com/signin");
  });

  it("rejects non-strings and over-long URLs", () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(safeExternalUrl(value)).toBeNull();
    }
    const long = `https://example.com/${"a".repeat(MAX_EXTERNAL_URL_LEN)}`;
    expect(safeExternalUrl(long)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The renderers, held to the same rules
// ---------------------------------------------------------------------------

const RENDERERS: Array<{ name: string; render: (markdown: string) => HTMLElement }> = [
  {
    name: "SimpleMarkdown (mobile chat, note summary, chat blocks)",
    render: (markdown) => render(<SimpleMarkdown text={markdown} />).container,
  },
  {
    name: "renderInlineMarkdown (desktop chat)",
    render: (markdown) => {
      const nodes: ReactNode[] = renderInlineMarkdown(markdown, 0);
      return render(
        <div>
          {nodes.map((node, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list rendered once, never reordered
            <span key={i}>{node}</span>
          ))}
        </div>,
      ).container;
    },
  },
];

/** Every attribute that could execute script if a renderer ever emitted raw HTML. */
const EVENT_ATTRIBUTE = /^on/i;

for (const renderer of RENDERERS) {
  describe(`link safety — ${renderer.name}`, () => {
    it("never emits an anchor for an unsafe href", () => {
      for (const href of REJECTED) {
        const container = renderer.render(`[click me](${href})`);
        const anchors = [...container.querySelectorAll("a")];
        expect(
          anchors,
          `${JSON.stringify(href)} produced an anchor in ${renderer.name}`,
        ).toHaveLength(0);
      }
    });

    it("emits a normalized https anchor for a safe href", () => {
      for (const href of ACCEPTED) {
        const container = renderer.render(`[click me](${href})`);
        const anchors = [...container.querySelectorAll("a")];
        expect(anchors, `${JSON.stringify(href)} produced no anchor`).toHaveLength(1);
        const rendered = anchors[0].getAttribute("href");
        expect(rendered).toBe(safeExternalHref(href));
        expect(anchors[0].getAttribute("rel")).toContain("noreferrer");
      }
    });

    it("keeps a rejected link readable rather than dropping it", () => {
      const container = renderer.render("[click me](javascript:alert(1))");
      expect(container.textContent).toContain("click me");
    });

    it("emits no event-handler attributes for any corpus entry", () => {
      for (const href of [...REJECTED, ...ACCEPTED]) {
        const container = renderer.render(`[click me](${href})`);
        for (const element of container.querySelectorAll("*")) {
          for (const attribute of element.attributes) {
            expect(
              EVENT_ATTRIBUTE.test(attribute.name),
              `${attribute.name} on <${element.tagName.toLowerCase()}> for ${href}`,
            ).toBe(false);
          }
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// No second door
// ---------------------------------------------------------------------------

/** `openExternalUrl` in `lib/tauri.ts` is the one sanctioned caller: it is the
 * browser-preview fallback for a URL that already passed the gate. */
const WINDOW_OPEN_ALLOWLIST = new Set(["src/lib/tauri.ts"]);

const WINDOW_OPEN = /\bwindow\s*\.\s*open\s*\(/;

describe("no second door to the browser", () => {
  it("sees enough of the source to be worth anything", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(200);
  });

  it("only lib/tauri.ts calls window.open", () => {
    const offenders = Object.entries(SOURCES)
      .map(([path, source]) => [path.replace("../", "src/"), source] as const)
      .filter(([path]) => !path.startsWith("src/test/"))
      .filter(([path]) => !WINDOW_OPEN_ALLOWLIST.has(path))
      .filter(([, source]) => WINDOW_OPEN.test(source))
      .map(([path]) => path);

    expect(offenders, "route these through openExternalUrl instead of window.open").toEqual([]);
  });
});
