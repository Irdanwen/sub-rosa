/**
 * A deck as a PowerPoint file: a port of `deliverables/pptx.rs` (ADR-0090),
 * the fixed scaffolding read from Rust's own templates. Five slide shapes
 * (title, bullets, two columns, picture, and notes on any of them), text boxes
 * placed explicitly, inline marks read with the Word writer's parser.
 *
 * A browser has no gallery to take a slide's picture from: the slide is kept
 * without it and the tool says so, the way the app reports a picture it
 * cannot find.
 */
import { parseInline } from "./docx";
import { coreXml, DOCUMENTS, DocumentInvalid, type Part } from "./exported";
import { asciiLower, asU64, isObject, type Json, lines, take, trim, xmlText } from "./text";

const MAX_SLIDES = 60;
const MAX_BULLETS = 14;
const MAX_TEXT = 2_000;
const MAX_NOTES = 8_000;
const SLIDE_WIDTH = 12_192_000;
const SLIDE_HEIGHT = 6_858_000;
const MARGIN = 548_640;
const TITLE_TOP = 365_760;
const TITLE_HEIGHT = 1_097_280;
const BODY_TOP = 1_554_480;
const GAP = 365_760;

type Layout = "title" | "bullets" | "two_column" | "image";
interface Bullet {
  text: string;
  level: number;
}
interface Column {
  heading: string | null;
  bullets: Bullet[];
}
interface Slide {
  layout: Layout;
  title: string;
  subtitle: string | null;
  bullets: Bullet[];
  left: Column;
  right: Column;
  image: string | null;
  caption: string | null;
  notes: string | null;
}

const capped = (text: string, max: number) => take(trim(text), max);

function parseBullets(value: Json | undefined): Bullet[] {
  if (!Array.isArray(value)) {
    if (typeof value !== "string") return [];
    return lines(value)
      .map((line) => trim(trim(line).replace(/^[-*•]+/u, "")))
      .filter(Boolean)
      .slice(0, MAX_BULLETS)
      .map((line) => ({ text: capped(line, MAX_TEXT), level: 0 }));
  }
  const out: Bullet[] = [];
  for (const item of value) {
    let bullet: Bullet | null = null;
    if (typeof item === "string") bullet = { text: capped(item, MAX_TEXT), level: 0 };
    else if (isObject(item) && typeof item.text === "string")
      bullet = { text: capped(item.text, MAX_TEXT), level: Math.min(3, asU64(item.level) ?? 0) };
    if (bullet?.text) out.push(bullet);
    if (out.length === MAX_BULLETS) break;
  }
  return out;
}

const either = (map: Record<string, Json>, a: string, b: string) => (a in map ? map[a] : map[b]);

function parseColumn(value: Json | undefined): Column {
  if (value === undefined) return { heading: null, bullets: [] };
  if (isObject(value)) {
    const heading = either(value, "heading", "title");
    const text = typeof heading === "string" ? capped(heading, MAX_TEXT) : "";
    return { heading: text || null, bullets: parseBullets(either(value, "bullets", "points")) };
  }
  return { heading: null, bullets: parseBullets(value) };
}

function parseSlide(index: number, value: Json): Slide | null {
  if (!isObject(value)) return null;
  const text = (key: string) => {
    const raw = value[key];
    const cut = typeof raw === "string" ? capped(raw, MAX_TEXT) : "";
    return cut || null;
  };
  const bullets = parseBullets(either(value, "bullets", "points"));
  const left = parseColumn(value.left);
  const right = parseColumn(value.right);
  const image = text("image");
  const subtitle = text("subtitle");
  const asked = asciiLower(typeof value.layout === "string" ? value.layout : "").replace(
    /[- ]/g,
    "_",
  );
  const layout: Layout = ["title", "section"].includes(asked)
    ? "title"
    : ["two_column", "two_columns", "columns", "comparison"].includes(asked)
      ? "two_column"
      : ["image", "picture"].includes(asked)
        ? "image"
        : ["bullets", "content"].includes(asked)
          ? "bullets"
          : image
            ? "image"
            : left.bullets.length || right.bullets.length
              ? "two_column"
              : !bullets.length && (index === 0 || subtitle)
                ? "title"
                : "bullets";
  const title = text("title") ?? "";
  const notes = typeof value.notes === "string" ? capped(value.notes, MAX_NOTES) || null : null;
  if (
    !title &&
    !subtitle &&
    !bullets.length &&
    !left.bullets.length &&
    !right.bullets.length &&
    !image
  )
    return null;
  return { layout, title, subtitle, bullets, left, right, image, caption: text("caption"), notes };
}

function parseSlides(content: Json): Slide[] {
  const raw = Array.isArray(content)
    ? content
    : isObject(content) && Array.isArray(content.slides)
      ? content.slides
      : [];
  const slides = raw
    .slice(0, MAX_SLIDES)
    .map((value, index) => parseSlide(index, value))
    .filter((slide): slide is Slide => slide !== null);
  if (!slides.length)
    throw new DocumentInvalid(
      "A presentation needs content.slides, each with a title and bullets, columns or an image.",
    );
  return slides;
}

function paragraph(
  text: string,
  size: number,
  bold: boolean,
  align: string | null,
  properties: string,
) {
  let runs = "";
  for (const inline of parseInline(text)) {
    const marked = inline.kind === "text" ? inline.bold : false;
    const italic = inline.kind === "text" ? inline.italic : false;
    runs += `<a:r><a:rPr lang="en-US" sz="${size}"${bold || marked ? ' b="1"' : ""}${italic ? ' i="1"' : ""} dirty="0"/><a:t>${xmlText(inline.text)}</a:t></a:r>`;
  }
  const aligned = align ? ` algn="${align}"` : "";
  return !properties && !aligned
    ? `<a:p>${runs}</a:p>`
    : `<a:p><a:pPr${aligned}>${properties}</a:pPr>${runs}</a:p>`;
}

function bulletParagraphs(bullets: Bullet[], size: number): string {
  return bullets
    .map((bullet) => {
      const properties =
        '<a:spcBef><a:spcPts val="600"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/>';
      const p = paragraph(
        bullet.text,
        Math.max(0, size - 200 * bullet.level),
        false,
        null,
        properties,
      );
      return p.replace(
        "<a:pPr>",
        `<a:pPr marL="${285_750 + bullet.level * 457_200}" lvl="${bullet.level}" indent="-285750">`,
      );
    })
    .join("");
}

class Shapes {
  xml = "";
  nextId = 2;
  textBox(name: string, [x, y, cx, cy]: number[], anchor: string, paragraphs: string) {
    const id = this.nextId++;
    this.xml += `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name} ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
  }
}

function slideXml(slide: Slide): string {
  const shapes = new Shapes();
  const width = SLIDE_WIDTH - 2 * MARGIN;
  const bodyHeight = SLIDE_HEIGHT - BODY_TOP - MARGIN;
  const heading = () => {
    if (slide.title)
      shapes.textBox(
        "Title",
        [MARGIN, TITLE_TOP, width, TITLE_HEIGHT],
        "b",
        paragraph(slide.title, 3200, true, null, ""),
      );
  };
  if (slide.layout === "title") {
    shapes.textBox(
      "Title",
      [MARGIN, 2_057_400, width, 1_600_200],
      "b",
      paragraph(slide.title, 4400, true, "ctr", ""),
    );
    if (slide.subtitle)
      shapes.textBox(
        "Subtitle",
        [MARGIN, 3_749_040, width, 1_143_000],
        "t",
        paragraph(slide.subtitle, 2400, false, "ctr", ""),
      );
    if (slide.bullets.length)
      shapes.textBox(
        "Text",
        [MARGIN, 4_937_760, width, 1_371_600],
        "t",
        bulletParagraphs(slide.bullets, 1800),
      );
  } else if (slide.layout === "bullets") {
    heading();
    let body = bulletParagraphs(slide.bullets, 2400);
    if (slide.subtitle) body = paragraph(slide.subtitle, 2000, false, null, "") + body;
    if (body) shapes.textBox("Content", [MARGIN, BODY_TOP, width, bodyHeight], "t", body);
  } else if (slide.layout === "two_column") {
    heading();
    const columnWidth = Math.trunc((width - GAP) / 2);
    for (const [offset, column] of [
      [0, slide.left],
      [columnWidth + GAP, slide.right],
    ] as [number, Column][]) {
      let body = "";
      if (column.heading) body += paragraph(column.heading, 2200, true, null, "");
      body += bulletParagraphs(column.bullets, 2000);
      if (body)
        shapes.textBox("Column", [MARGIN + offset, BODY_TOP, columnWidth, bodyHeight], "t", body);
    }
  } else {
    heading();
    const captionHeight = slide.caption ? 457_200 : 0;
    const pictureHeight = bodyHeight - captionHeight;
    let pictureLeft = MARGIN;
    let pictureWidth = width;
    if (slide.bullets.length) {
      const half = Math.trunc((width - GAP) / 2);
      shapes.textBox(
        "Content",
        [MARGIN, BODY_TOP, half, bodyHeight],
        "t",
        bulletParagraphs(slide.bullets, 2000),
      );
      pictureLeft = MARGIN + half + GAP;
      pictureWidth = half;
    }
    if (slide.caption)
      shapes.textBox(
        "Caption",
        [pictureLeft, BODY_TOP + pictureHeight, pictureWidth, captionHeight],
        "t",
        paragraph(slide.caption, 1400, false, "ctr", ""),
      );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${DOCUMENTS.templates.pptx.ns}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.xml}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function notesXml(notes: string): string {
  const paragraphs = lines(notes)
    .map(
      (line) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xmlText(line)}</a:t></a:r></a:p>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes ${DOCUMENTS.templates.pptx.ns}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs || "<a:p/>"}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

function relsXml(rels: [string, string][]): string {
  let xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  rels.forEach(([kind, target], index) => {
    xml += `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${target}"/>`;
  });
  return `${xml}</Relationships>`;
}

function presentationXml(slides: number, notes: boolean): string {
  let ids = "";
  for (let n = 0; n < slides; n++) ids += `<p:sldId id="${256 + n}" r:id="rId${n + 2}"/>`;
  const master = notes
    ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${slides + 2}"/></p:notesMasterIdLst>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation ${DOCUMENTS.templates.pptx.ns} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${master}<p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`;
}

function presentationRels(slides: number, notes: boolean): string {
  const rels: [string, string][] = [["slideMaster", "slideMasters/slideMaster1.xml"]];
  for (let n = 1; n <= slides; n++) rels.push(["slide", `slides/slide${n}.xml`]);
  if (notes) rels.push(["notesMaster", "notesMasters/notesMaster1.xml"]);
  rels.push(
    ["presProps", "presProps.xml"],
    ["viewProps", "viewProps.xml"],
    ["theme", "theme/theme1.xml"],
    ["tableStyles", "tableStyles.xml"],
  );
  return relsXml(rels);
}

function contentTypes(slides: Slide[], notes: boolean): string {
  const main = "application/vnd.openxmlformats-officedocument.presentationml";
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/ppt/presentation.xml" ContentType="${main}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${main}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${main}.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="${main}.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="${main}.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="${main}.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`;
  if (notes)
    xml += `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${main}.notesMaster+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`;
  slides.forEach((slide, index) => {
    const n = index + 1;
    xml += `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${main}.slide+xml"/>`;
    if (slide.notes)
      xml += `<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="${main}.notesSlide+xml"/>`;
  });
  return `${xml}</Types>`;
}

/** Why a slide's picture is left out in a browser: the app's own sentence
 * for a picture it cannot find in the gallery. */
export const missingPicture = (reference: string) =>
  `${reference} is not a picture in the gallery, so the slide has no picture`;

/** The deck's parts, and what was asked for and left out. */
export function buildPptx(
  title: string,
  content: Json,
  now?: Date,
): { parts: Part[]; warnings: string[] } {
  const slides = parseSlides(content);
  const t = DOCUMENTS.templates.pptx;
  const warnings: string[] = [];
  const files: Part[] = [];
  let hasNotes = false;
  slides.forEach((slide, index) => {
    const number = index + 1;
    const rels: [string, string][] = [["slideLayout", "../slideLayouts/slideLayout1.xml"]];
    if (slide.image) warnings.push(`Slide ${number}: ${missingPicture(slide.image)}`);
    if (slide.notes) {
      hasNotes = true;
      rels.push(["notesSlide", `../notesSlides/notesSlide${number}.xml`]);
    }
    files.push({ name: `ppt/slides/slide${number}.xml`, text: slideXml(slide) });
    files.push({ name: `ppt/slides/_rels/slide${number}.xml.rels`, text: relsXml(rels) });
    if (slide.notes) {
      files.push({ name: `ppt/notesSlides/notesSlide${number}.xml`, text: notesXml(slide.notes) });
      files.push({
        name: `ppt/notesSlides/_rels/notesSlide${number}.xml.rels`,
        text: relsXml([
          ["notesMaster", "../notesMasters/notesMaster1.xml"],
          ["slide", `../slides/slide${number}.xml`],
        ]),
      });
    }
  });
  const parts: Part[] = [
    { name: "[Content_Types].xml", text: contentTypes(slides, hasNotes) },
    { name: "_rels/.rels", text: t.rootRels },
    { name: "docProps/core.xml", text: coreXml(title, now) },
    { name: "ppt/presentation.xml", text: presentationXml(slides.length, hasNotes) },
    { name: "ppt/_rels/presentation.xml.rels", text: presentationRels(slides.length, hasNotes) },
    { name: "ppt/slideMasters/slideMaster1.xml", text: t.slideMaster },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", text: t.slideMasterRels },
    { name: "ppt/slideLayouts/slideLayout1.xml", text: t.slideLayout },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", text: t.slideLayoutRels },
    { name: "ppt/theme/theme1.xml", text: t.theme },
    { name: "ppt/presProps.xml", text: t.presProps },
    { name: "ppt/viewProps.xml", text: t.viewProps },
    { name: "ppt/tableStyles.xml", text: t.tableStyles },
  ];
  if (hasNotes)
    parts.push(
      { name: "ppt/notesMasters/notesMaster1.xml", text: t.notesMaster },
      { name: "ppt/notesMasters/_rels/notesMaster1.xml.rels", text: t.notesMasterRels },
      { name: "ppt/theme/theme2.xml", text: t.theme },
    );
  return { parts: [...parts, ...files], warnings };
}
