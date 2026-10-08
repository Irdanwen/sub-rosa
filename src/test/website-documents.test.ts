import { describe, expect, it } from "vitest";
import {
  attachToLastUserMessage,
  visionModelFor,
  withAttachmentMarkers,
} from "../../website/src/client/attachments";
import type { ChatMessage } from "../../website/src/client/carpe-diem";
import { DocumentError, readDocument, xmlText } from "../../website/src/client/documents";
import { MAX_SELECTED_BYTES, ZipError, zipEntries } from "../../website/src/client/zip";

/** A zip the way Office writes one: deflated entries, a central directory. */
async function zip(files: Record<string, string>, method: 0 | 8 = 8): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = encoder.encode(content);
    const data =
      method === 8
        ? new Uint8Array(
            await new Response(
              (new Response(raw).body as ReadableStream<BufferSource>).pipeThrough(
                new CompressionStream("deflate-raw"),
              ),
            ).arrayBuffer(),
          )
        : raw;
    const nameBytes = encoder.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, directory, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directory + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("reading documents in the browser", () => {
  it("reads Word text under [Document], a line per paragraph", async () => {
    const bytes = await zip({
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>Budget &amp; plan</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Second </w:t></w:r><w:r><w:t>line</w:t></w:r></w:p></w:body></w:document>',
    });
    const document = await readDocument({ name: "plan.docx", bytes });
    expect(document.text).toBe("[Document]\nBudget & plan\nSecond line\n\n");
    expect(document.format).toBe("docx");
  });

  it("reads Excel cells as ref: value under each sheet, shared strings resolved", async () => {
    const bytes = await zip({
      "xl/sharedStrings.xml": "<sst><si><t>Revenue</t></si><si><t>North</t></si></sst>",
      "xl/worksheets/sheet2.xml":
        '<worksheet><sheetData><row><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1200</v></c></row><row><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>n/a</t></is></c></row></sheetData></worksheet>',
    });
    const document = await readDocument({ name: "q.xlsx", bytes });
    expect(document.text).toBe(
      "[Sheet 1]\nA1: Revenue\nB1: 1200\nA2: North\nB2: n/a\n\n[Sheet 2]\nA1: 7\n\n",
    );
    expect(document.sheets).toBe(2);
  });

  it("reads PowerPoint slides in slide order", async () => {
    const bytes = await zip(
      {
        "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>",
        "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Two</a:t></a:r></a:p></p:sld>",
      },
      0,
    );
    const document = await readDocument({ name: "deck.pptx", bytes });
    expect(document.text).toBe("[Slide 1]\nTwo\n\n[Slide 2]\nTen\n\n");
    expect(document.slides).toBe(2);
  });

  it("reads a PDF page by page, and says a scan is a scan", async () => {
    const pdf = await readDocument({ name: "a.pdf", bytes: new Uint8Array(4) }, async () => [
      "Page one",
      "Page two",
    ]);
    expect(pdf.text).toBe("[Page 1]\nPage one\n[Page 2]\nPage two\n");
    expect(pdf.pages).toBe(2);
    await expect(
      readDocument({ name: "scan.pdf", bytes: new Uint8Array(4) }, async () => ["", " "]),
    ).rejects.toMatchObject({ code: "scan" });
  });

  it("reads text files as they are and refuses what the app refuses", async () => {
    const csv = await readDocument({ name: "a.csv", bytes: new TextEncoder().encode("a,b\n1,2") });
    expect(csv.text).toBe("a,b\n1,2");
    await expect(readDocument({ name: "a.exe", bytes: new Uint8Array(1) })).rejects.toBeInstanceOf(
      DocumentError,
    );
    await expect(
      readDocument({ name: "big.txt", bytes: new Uint8Array(600 * 1024) }),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      readDocument({ name: "blank.md", bytes: new TextEncoder().encode("  ") }),
    ).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("refuses a zip bomb at the budget and a file that is no zip", async () => {
    const bytes = await zip({
      "word/document.xml": `<w:p>${"a".repeat(MAX_SELECTED_BYTES + 10)}</w:p>`,
    });
    await expect(readDocument({ name: "bomb.docx", bytes })).rejects.toMatchObject({
      code: "unreadable",
    });
    expect(() => zipEntries(new Uint8Array(100))).toThrow(ZipError);
  });

  it("decodes entities and breaks lines where the app does", () => {
    expect(xmlText("<a:p><a:t>&lt;x&gt; &#233;&#x41;</a:t></a:p><a:p/>")).toBe("<x> éA\n");
  });
});

describe("attachments and vision", () => {
  it("stores markers and carries the content with the turn only", () => {
    const attachments = [
      { kind: "text" as const, name: "notes.txt", data: "abc" },
      { kind: "image" as const, name: "cat.jpg", data: "data:image/jpeg;base64,AAAA" },
    ];
    expect(withAttachmentMarkers("Look", attachments)).toBe(
      "Look\n[File: notes.txt] [Image: cat.jpg]",
    );
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "Look" },
    ];
    attachToLastUserMessage(messages, attachments);
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Look\n\n[File: notes.txt]\n```\nabc\n```" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
      ],
    });
  });

  it("truncates the text files of one turn at the app's budget", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "q" }];
    attachToLastUserMessage(messages, [
      { kind: "text", name: "big.txt", data: "x".repeat(70_000) },
    ]);
    const content = messages[0].content as string;
    expect(content.endsWith("\n[Remaining file content truncated.]")).toBe(true);
    expect(content.length).toBeLessThan(60_100);
  });

  it("routes an image turn to a model as private, or refuses it", () => {
    const models = [
      { id: "text-private", name: "B", privacy: "private" },
      { id: "vision-anon", name: "A", privacy: "anonymized", supportsVision: true },
      { id: "vision-private-z", name: "Z", privacy: "private", supportsVision: true },
      { id: "vision-private-c", name: "C", privacy: "private", supportsVision: true },
    ];
    expect(visionModelFor(models, "vision-anon")).toBe("vision-anon");
    expect(visionModelFor(models, "text-private")).toBe("vision-private-c");
    expect(visionModelFor(models.slice(0, 2), "text-private")).toBeNull();
  });
});
