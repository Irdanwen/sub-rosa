import { describe, expect, it } from "vitest";
import fixtures from "../../packages/chat-core/web/documents-fixtures.json";
import {
  build,
  fileBlock,
  packageParts,
  parseRequest,
  toolReply,
} from "../../website/src/client/documents/make";
import { columnLetters, isoDateSerial } from "../../website/src/client/documents/writers/xlsx";
import { rustFloat } from "../../website/src/client/documents/writers/text";
import { crc32, readZip } from "../../website/src/client/documents/writers/zip";

interface Case {
  request: Record<string, unknown>;
  error?: string;
  kind?: string;
  title?: string;
  detail?: string;
  warnings?: string[];
  parts?: { name: string; text: string }[];
}

const CREATED = /<dcterms:created xsi:type="dcterms:W3CDTF">[^<]*<\/dcterms:created>/;
const normalised = (text: string) =>
  text.replace(CREATED, '<dcterms:created xsi:type="dcterms:W3CDTF">CREATED</dcterms:created>');

describe("the web's Office writers", () => {
  const cases = (fixtures as { cases: Case[] }).cases;

  it.each(cases.map((item, index) => [index, item] as const))(
    "write what Rust writes for request %i",
    (_, item) => {
      if (item.error) {
        expect(() => build(parseRequest(item.request))).toThrow(item.error);
        return;
      }
      const request = parseRequest(item.request);
      expect(request.kind).toBe(item.kind);
      expect(request.title).toBe(item.title);
      const built = build(request);
      expect(built.detail).toBe(item.detail);
      expect(built.warnings).toEqual(item.warnings);
      expect(built.parts.map((part) => part.name)).toEqual(item.parts?.map((part) => part.name));
      built.parts.forEach((part, index) => {
        expect(normalised(part.text), part.name).toBe(item.parts?.[index].text);
      });
    },
  );

  it("packages a zip readers can open, every part intact", async () => {
    const request = parseRequest(cases[0].request);
    const built = build(request);
    const bytes = await packageParts(built.parts);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");
    const read = await readZip(bytes);
    expect(read.map((entry) => entry.name)).toEqual(built.parts.map((part) => part.name));
    expect(new TextDecoder().decode(read[3].bytes)).toBe(built.parts[3].text);
    expect(read[0].name).toBe("[Content_Types].xml");
  });

  it("computes the checksum zip readers check", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("prints numbers and dates the way Rust does", () => {
    expect(rustFloat(1.5e22)).toBe("15000000000000000000000");
    expect(rustFloat(-2.5e-7)).toBe("-0.00000025");
    expect(rustFloat(450.5)).toBe("450.5");
    expect(isoDateSerial("2026-10-08")).toBe(46303);
    expect(isoDateSerial("2026-02-30")).toBeNull();
    expect(isoDateSerial("2026-10-08T12:00")).toBe(46303.5);
    expect(columnLetters(701)).toBe("ZZ");
    expect(columnLetters(702)).toBe("AAA");
  });

  it("answers the model with the block that names the file, never a path", () => {
    const made = {
      file: "0b7c1d2e-0000-4000-8000-000000000000.pptx",
      title: 'Board "deck"',
      kind: "pptx" as const,
      bytes: 10,
      detail: "3 slides",
      warnings: ["Slide 2: x.png missing"],
    };
    const block = fileBlock(made);
    expect(block).toBe(
      '```subrosa:file\n{"detail":"3 slides","file":"0b7c1d2e-0000-4000-8000-000000000000.pptx","kind":"pptx","title":"Board \\"deck\\"","v":1}\n```',
    );
    const reply = toolReply(made);
    expect(reply).toContain('PowerPoint deck "Board "deck""');
    expect(reply).toContain(block);
    expect(reply.endsWith("Slide 2: x.png missing.")).toBe(true);
    expect(toolReply({ ...made, warnings: [] })).not.toContain("left out");
  });
});
