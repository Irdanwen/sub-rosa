//! A Markdown document as a Word file (`.docx`), written by hand.
//!
//! A `.docx` is a zip of a few XML parts (WordprocessingML, ECMA-376). The
//! notes this app writes are Markdown with a known, small vocabulary
//! (ADR-0037): headings, paragraphs, bulleted and numbered lists, quotes,
//! code blocks, tables, bold, italic, inline code and links. That is a page
//! of XML templates, not a dependency, so the writer is this module:
//!
//! - **Real structure, not styled text.** Headings use Word's own `Heading1`
//!   to `Heading3` styles (so the navigation pane and a table of contents
//!   work), lists use a numbering part (each numbered list restarts at 1),
//!   links are hyperlink relationships a reader can click, and tables are
//!   tables.
//! - **Everything the model wrote is text.** Every run is escaped, and the
//!   characters XML 1.0 forbids are dropped, so no reply can break the file.
//!
//! Shared by both shells: the deep research report exports through it
//! (ADR-0089), and any note can.

use std::io::{Cursor, Write};

use crate::domain::types::AppError;

/// One piece of a line, with its marks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inline {
    Text {
        text: String,
        bold: bool,
        italic: bool,
        code: bool,
    },
    Link {
        text: String,
        url: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Block {
    Heading(u8, String),
    Paragraph(String),
    Bullet(String),
    /// The list it belongs to (each one restarts at 1), and its text.
    Numbered(usize, String),
    Quote(String),
    Code(String),
    Table(Vec<Vec<String>>),
}

fn parse_blocks(markdown: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut paragraph: Vec<String> = Vec::new();
    let mut lists = 0usize;
    let mut in_numbered = false;
    let mut lines = markdown.lines().peekable();
    let flush = |paragraph: &mut Vec<String>, blocks: &mut Vec<Block>| {
        if !paragraph.is_empty() {
            blocks.push(Block::Paragraph(paragraph.join(" ")));
            paragraph.clear();
        }
    };
    while let Some(raw) = lines.next() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            flush(&mut paragraph, &mut blocks);
            in_numbered = false;
            for code in lines.by_ref() {
                if code.trim_start().starts_with("```") {
                    break;
                }
                blocks.push(Block::Code(code.to_string()));
            }
            continue;
        }
        if trimmed.is_empty() {
            flush(&mut paragraph, &mut blocks);
            continue;
        }
        if let Some((level, text)) = heading(trimmed) {
            flush(&mut paragraph, &mut blocks);
            in_numbered = false;
            blocks.push(Block::Heading(level, text.to_string()));
            continue;
        }
        if matches!(trimmed, "---" | "***" | "___") {
            flush(&mut paragraph, &mut blocks);
            in_numbered = false;
            continue;
        }
        if trimmed.starts_with('|') {
            flush(&mut paragraph, &mut blocks);
            in_numbered = false;
            let mut rows = vec![table_cells(trimmed)];
            while let Some(next) = lines.peek() {
                let next = next.trim();
                if !next.starts_with('|') {
                    break;
                }
                let cells = table_cells(next);
                let separator = cells
                    .iter()
                    .all(|cell| !cell.is_empty() && cell.chars().all(|c| matches!(c, '-' | ':')));
                if !separator {
                    rows.push(cells);
                }
                lines.next();
            }
            blocks.push(Block::Table(rows));
            continue;
        }
        if let Some(text) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
        {
            flush(&mut paragraph, &mut blocks);
            in_numbered = false;
            blocks.push(Block::Bullet(text.trim().to_string()));
            continue;
        }
        if let Some(text) = numbered_item(trimmed) {
            flush(&mut paragraph, &mut blocks);
            if !in_numbered {
                lists += 1;
                in_numbered = true;
            }
            blocks.push(Block::Numbered(lists, text.to_string()));
            continue;
        }
        if let Some(text) = trimmed.strip_prefix('>') {
            flush(&mut paragraph, &mut blocks);
            in_numbered = false;
            blocks.push(Block::Quote(text.trim().to_string()));
            continue;
        }
        in_numbered = false;
        paragraph.push(trimmed.to_string());
    }
    flush(&mut paragraph, &mut blocks);
    blocks
}

fn heading(line: &str) -> Option<(u8, &str)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = line[hashes..].strip_prefix(' ')?;
    Some(((hashes as u8).min(3), rest.trim()))
}

fn numbered_item(line: &str) -> Option<&str> {
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 4 {
        return None;
    }
    let rest = &line[digits..];
    rest.strip_prefix(". ")
        .or_else(|| rest.strip_prefix(") "))
        .map(str::trim)
}

/// A table row's cells. `\|` is a pipe inside a cell, not a border: the
/// backslash stays for the inline parser, which reads it as the character.
fn table_cells(line: &str) -> Vec<String> {
    let mut inner = line.trim().trim_start_matches('|');
    if inner.ends_with('|') && !inner.ends_with("\\|") {
        inner = &inner[..inner.len() - 1];
    }
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for c in inner.chars() {
        if c == '|' && !escaped {
            cells.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(c);
        }
        escaped = c == '\\' && !escaped;
    }
    cells.push(current.trim().to_string());
    cells
}

/// The marks of a line: `**bold**`, `*italic*` or `_italic_`, `` `code` ``
/// and `[text](url)`. A backslash keeps the next character literal.
pub fn parse_inline(text: &str) -> Vec<Inline> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<Inline> = Vec::new();
    let mut current = String::new();
    let (mut bold, mut italic) = (false, false);
    let push = |out: &mut Vec<Inline>, current: &mut String, bold: bool, italic: bool| {
        if !current.is_empty() {
            out.push(Inline::Text {
                text: std::mem::take(current),
                bold,
                italic,
                code: false,
            });
        }
    };
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            current.push(chars[i + 1]);
            i += 2;
            continue;
        }
        if c == '`' {
            if let Some(end) = chars[i + 1..].iter().position(|&x| x == '`') {
                push(&mut out, &mut current, bold, italic);
                out.push(Inline::Text {
                    text: chars[i + 1..i + 1 + end].iter().collect(),
                    bold,
                    italic,
                    code: true,
                });
                i += end + 2;
                continue;
            }
        }
        if c == '[' {
            if let Some((label, url, consumed)) = link_at(&chars[i..]) {
                push(&mut out, &mut current, bold, italic);
                out.push(Inline::Link { text: label, url });
                i += consumed;
                continue;
            }
        }
        if c == '*' && chars.get(i + 1) == Some(&'*') {
            push(&mut out, &mut current, bold, italic);
            bold = !bold;
            i += 2;
            continue;
        }
        if c == '*' || c == '_' {
            // Emphasis opens before a word and closes after one; an `_`
            // inside a word (snake_case) and a `*` between spaces (2 * 3)
            // are the characters themselves.
            let prev = i.checked_sub(1).map(|p| chars[p]);
            let next = chars.get(i + 1).copied();
            let opens = !italic
                && next.is_some_and(|n| !n.is_whitespace())
                && (c == '*' || prev.map_or(true, |p| !p.is_alphanumeric()));
            let closes = italic
                && prev.is_some_and(|p| !p.is_whitespace())
                && (c == '*' || next.map_or(true, |n| !n.is_alphanumeric()));
            if opens || closes {
                push(&mut out, &mut current, bold, italic);
                italic = !italic;
                i += 1;
                continue;
            }
        }
        current.push(c);
        i += 1;
    }
    push(&mut out, &mut current, bold, italic);
    out
}

/// `[label](url)` at the start of `chars`: the label, the url and how many
/// characters it spans. Only web and mail addresses become links.
fn link_at(chars: &[char]) -> Option<(String, String, usize)> {
    let close = chars.iter().position(|&c| c == ']')?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = chars[close + 2..].iter().position(|&c| c == ')')? + close + 2;
    let label: String = chars[1..close].iter().collect();
    let url: String = chars[close + 2..end]
        .iter()
        .collect::<String>()
        .trim()
        .to_string();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:"))
    {
        return None;
    }
    Some((label, url, end + 1))
}

/// Text as XML character data: escaped, and without the control characters
/// XML 1.0 refuses (a single one makes Word reject the whole file).
pub fn xml_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' => out.push(' '),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

struct Writer {
    body: String,
    links: Vec<String>,
    numbered_lists: usize,
}

impl Writer {
    fn runs(&mut self, text: &str) -> String {
        let mut out = String::new();
        for inline in parse_inline(text) {
            match inline {
                Inline::Text {
                    text,
                    bold,
                    italic,
                    code,
                } => out.push_str(&run(&text, bold, italic, code, false)),
                Inline::Link { text, url } => {
                    self.links.push(url);
                    let id = format!("rLink{}", self.links.len());
                    out.push_str(&format!(
                        "<w:hyperlink r:id=\"{id}\" w:history=\"1\">{}</w:hyperlink>",
                        run(&text, false, false, false, true)
                    ));
                }
            }
        }
        out
    }

    fn paragraph(&mut self, style: Option<&str>, numbering: Option<usize>, text: &str) {
        let runs = self.runs(text);
        self.push_paragraph(style, numbering, &runs);
    }

    fn push_paragraph(&mut self, style: Option<&str>, numbering: Option<usize>, runs: &str) {
        let mut properties = String::new();
        if let Some(style) = style {
            properties.push_str(&format!("<w:pStyle w:val=\"{style}\"/>"));
        }
        if let Some(num) = numbering {
            properties.push_str(&format!(
                "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"{num}\"/></w:numPr>"
            ));
        }
        if properties.is_empty() {
            self.body.push_str(&format!("<w:p>{runs}</w:p>"));
        } else {
            self.body
                .push_str(&format!("<w:p><w:pPr>{properties}</w:pPr>{runs}</w:p>"));
        }
    }

    fn table(&mut self, rows: &[Vec<String>]) {
        let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
        if columns == 0 {
            return;
        }
        let mut xml = String::from(
            "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr><w:tblGrid>",
        );
        for _ in 0..columns {
            xml.push_str("<w:gridCol/>");
        }
        xml.push_str("</w:tblGrid>");
        for (index, row) in rows.iter().enumerate() {
            xml.push_str("<w:tr>");
            for column in 0..columns {
                let text = row.get(column).map(String::as_str).unwrap_or("");
                let runs = if index == 0 {
                    // The header row reads as one: bold, whatever its marks.
                    run(&plain(text), true, false, false, false)
                } else {
                    self.runs(text)
                };
                xml.push_str(&format!("<w:tc><w:p>{runs}</w:p></w:tc>"));
            }
            xml.push_str("</w:tr>");
        }
        xml.push_str("</w:tbl>");
        self.body.push_str(&xml);
        // Word wants a paragraph between two tables and after the last one.
        self.body.push_str("<w:p/>");
    }
}

/// A line's text without its marks.
pub fn plain(text: &str) -> String {
    parse_inline(text)
        .into_iter()
        .map(|inline| match inline {
            Inline::Text { text, .. } | Inline::Link { text, .. } => text,
        })
        .collect()
}

fn run(text: &str, bold: bool, italic: bool, code: bool, link: bool) -> String {
    let mut properties = String::new();
    if link {
        properties.push_str("<w:rStyle w:val=\"Hyperlink\"/>");
    }
    if code {
        properties.push_str("<w:rStyle w:val=\"CodeChar\"/>");
    }
    if bold {
        properties.push_str("<w:b/>");
    }
    if italic {
        properties.push_str("<w:i/>");
    }
    let properties = if properties.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{properties}</w:rPr>")
    };
    format!(
        "<w:r>{properties}<w:t xml:space=\"preserve\">{}</w:t></w:r>",
        xml_text(text)
    )
}

const NS: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"";

/// The document part, and the link targets its `rLinkN` ids point at.
fn document_xml(title: &str, markdown: &str) -> (String, Vec<String>, usize) {
    let mut writer = Writer {
        body: String::new(),
        links: Vec::new(),
        numbered_lists: 0,
    };
    let blocks = parse_blocks(markdown);
    // The title becomes the document's Title unless the text opens with it.
    let opens_with_title = matches!(blocks.first(), Some(Block::Heading(1, text)) if plain(text).trim() == title.trim());
    if !opens_with_title && !title.trim().is_empty() {
        writer.paragraph(Some("Title"), None, title.trim());
    }
    for (index, block) in blocks.iter().enumerate() {
        match block {
            Block::Heading(1, text) if index == 0 && opens_with_title => {
                writer.paragraph(Some("Title"), None, text);
            }
            Block::Heading(level, text) => {
                writer.paragraph(Some(&format!("Heading{level}")), None, text);
            }
            Block::Paragraph(text) => writer.paragraph(None, None, text),
            Block::Bullet(text) => writer.paragraph(Some("ListParagraph"), Some(1), text),
            Block::Numbered(list, text) => {
                writer.numbered_lists = writer.numbered_lists.max(*list);
                // numId 1 is the bullets; numbered list n is numId n + 1.
                writer.paragraph(Some("ListParagraph"), Some(list + 1), text);
            }
            Block::Quote(text) => writer.paragraph(Some("Quote"), None, text),
            Block::Code(text) => {
                let runs = run(text, false, false, false, false);
                writer.push_paragraph(Some("Code"), None, &runs);
            }
            Block::Table(rows) => writer.table(rows),
        }
    }
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document {NS}><w:body>{}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>",
        writer.body
    );
    (xml, writer.links, writer.numbered_lists)
}

fn numbering_xml(numbered_lists: usize) -> String {
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:numbering {NS}>\
<w:abstractNum w:abstractNumId=\"0\"><w:multiLevelType w:val=\"singleLevel\"/><w:lvl w:ilvl=\"0\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"\u{2022}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"720\" w:hanging=\"360\"/></w:pPr></w:lvl></w:abstractNum>\
<w:abstractNum w:abstractNumId=\"1\"><w:multiLevelType w:val=\"singleLevel\"/><w:lvl w:ilvl=\"0\"><w:start w:val=\"1\"/><w:numFmt w:val=\"decimal\"/><w:lvlText w:val=\"%1.\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"720\" w:hanging=\"360\"/></w:pPr></w:lvl></w:abstractNum>\
<w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num>"
    );
    for list in 1..=numbered_lists {
        xml.push_str(&format!(
            "<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"1\"/><w:lvlOverride w:ilvl=\"0\"><w:startOverride w:val=\"1\"/></w:lvlOverride></w:num>",
            list + 1
        ));
    }
    xml.push_str("</w:numbering>");
    xml
}

pub(crate) const STYLES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/></w:rPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>"#;

pub(crate) const CONTENT_TYPES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>"#;

pub(crate) const ROOT_RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#;

fn document_rels_xml(links: &[String]) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>",
    );
    for (index, url) in links.iter().enumerate() {
        xml.push_str(&format!(
            "<Relationship Id=\"rLink{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",
            index + 1,
            xml_text(url)
        ));
    }
    xml.push_str("</Relationships>");
    xml
}

pub(crate) fn core_xml(title: &str) -> String {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title>{}</dc:title><dc:creator>Sub Rosa</dc:creator><dcterms:created xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:created></cp:coreProperties>",
        xml_text(title.trim())
    )
}

/// The `.docx` bytes for a Markdown document.
pub fn markdown_to_docx(title: &str, markdown: &str) -> Result<Vec<u8>, AppError> {
    let (document, links, numbered_lists) = document_xml(title, markdown);
    let parts: [(&str, String); 7] = [
        ("[Content_Types].xml", CONTENT_TYPES_XML.to_string()),
        ("_rels/.rels", ROOT_RELS_XML.to_string()),
        ("docProps/core.xml", core_xml(title)),
        ("word/document.xml", document),
        ("word/styles.xml", STYLES_XML.to_string()),
        ("word/numbering.xml", numbering_xml(numbered_lists)),
        ("word/_rels/document.xml.rels", document_rels_xml(&links)),
    ];
    let failed = |error: &dyn std::fmt::Display| AppError::new("docx_failed", error.to_string());
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, content) in parts {
        zip.start_file(name, options).map_err(|e| failed(&e))?;
        zip.write_all(content.as_bytes()).map_err(|e| failed(&e))?;
    }
    let cursor = zip.finish().map_err(|e| failed(&e))?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn part(bytes: &[u8], name: &str) -> String {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut file = archive.by_name(name).unwrap();
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        text
    }

    const REPORT: &str = "# Heat pumps in old houses\n\n## Executive summary\n\nThey **work** in *most* cases [1].\nSee `COP` values.\n\n## Findings\n\n- Insulation first\n- Radiators sized for 55 °C\n\n1. Survey\n2. Quote\n\nText between.\n\n1. Again from one\n\n> A quoted line & <tag>\n\n| Model | COP |\n|---|---|\n| A | 3.1 |\n\n```\nlet x = 1;\n```\n\n## Sources\n\n1. [Energy agency](https://example.org/a?b=1&c=2)\n";

    #[test]
    fn a_report_becomes_a_word_file_with_its_structure() {
        let bytes = markdown_to_docx("Heat pumps in old houses", REPORT).unwrap();
        assert!(bytes.starts_with(b"PK"));
        let types = part(&bytes, "[Content_Types].xml");
        assert!(types.contains("wordprocessingml.document.main+xml"));
        let document = part(&bytes, "word/document.xml");
        // The opening heading is the title, once.
        assert_eq!(document.matches("Heat pumps in old houses").count(), 1);
        assert!(document.contains("<w:pStyle w:val=\"Title\"/>"));
        assert!(!document.contains("<w:pStyle w:val=\"Heading1\"/>"));
        assert_eq!(
            document.matches("<w:pStyle w:val=\"Heading2\"/>").count(),
            3
        );
        assert!(document.contains("<w:b/></w:rPr><w:t xml:space=\"preserve\">work</w:t>"));
        assert!(document.contains("<w:i/></w:rPr><w:t xml:space=\"preserve\">most</w:t>"));
        assert!(document.contains("<w:rStyle w:val=\"CodeChar\"/>"));
        // Bullets share numId 1; each numbered list has its own, from 1.
        assert_eq!(document.matches("<w:numId w:val=\"1\"/>").count(), 2);
        assert_eq!(document.matches("<w:numId w:val=\"2\"/>").count(), 2);
        assert_eq!(document.matches("<w:numId w:val=\"3\"/>").count(), 1);
        assert!(document.contains("A quoted line &amp; &lt;tag&gt;"));
        assert!(document.contains("<w:tbl>"));
        assert_eq!(document.matches("<w:tr>").count(), 2);
        assert!(document.contains("let x = 1;"));
        let numbering = part(&bytes, "word/numbering.xml");
        assert!(numbering.contains("w:numId=\"4\""));
        assert!(numbering.contains("<w:startOverride w:val=\"1\"/>"));
        // The link is a clickable relationship with its address escaped.
        assert!(document.contains("<w:hyperlink r:id=\"rLink1\""));
        let rels = part(&bytes, "word/_rels/document.xml.rels");
        assert!(rels.contains(
            "Id=\"rLink1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"https://example.org/a?b=1&amp;c=2\" TargetMode=\"External\""
        ));
        assert!(part(&bytes, "docProps/core.xml")
            .contains("<dc:title>Heat pumps in old houses</dc:title>"));
    }

    #[test]
    fn the_app_reads_back_what_it_wrote() {
        let bytes = markdown_to_docx("Report", REPORT).unwrap();
        let text = crate::documents::extract_for_chat("report.docx", bytes)
            .unwrap()
            .text;
        assert!(text.contains("Executive summary"));
        assert!(text.contains("Radiators sized for 55 °C"));
        assert!(text.contains("Energy agency"));
    }

    #[test]
    fn control_characters_and_odd_marks_cannot_break_the_file() {
        let bytes = markdown_to_docx(
            "T\u{1}itle",
            "bad \u{0}\u{8} chars, snake_case_name, 2 * 3, [x](javascript:alert(1))",
        )
        .unwrap();
        let document = part(&bytes, "word/document.xml");
        assert!(!document.contains('\u{0}') && !document.contains('\u{8}'));
        assert!(document.contains("snake_case_name"));
        assert!(!document.contains("javascript:") || !document.contains("w:hyperlink"));
        assert!(part(&bytes, "docProps/core.xml").contains("<dc:title>Title</dc:title>"));
    }

    #[test]
    fn an_escaped_pipe_stays_inside_its_cell() {
        assert_eq!(table_cells("| a \\| b | c |"), vec!["a \\| b", "c"]);
        assert_eq!(table_cells("|x|y"), vec!["x", "y"]);
        let bytes = markdown_to_docx("T", "| Plan | Cost |\n|---|---|\n| A \\| B | 3 |\n").unwrap();
        let document = part(&bytes, "word/document.xml");
        assert!(document.contains(">A | B</w:t>"));
        assert_eq!(document.matches("<w:tc>").count(), 4);
    }

    #[test]
    fn inline_marks_are_read_as_written() {
        assert_eq!(
            parse_inline("a **b** [c](https://x.y) \\*d"),
            vec![
                Inline::Text {
                    text: "a ".into(),
                    bold: false,
                    italic: false,
                    code: false
                },
                Inline::Text {
                    text: "b".into(),
                    bold: true,
                    italic: false,
                    code: false
                },
                Inline::Text {
                    text: " ".into(),
                    bold: false,
                    italic: false,
                    code: false
                },
                Inline::Link {
                    text: "c".into(),
                    url: "https://x.y".into()
                },
                Inline::Text {
                    text: " *d".into(),
                    bold: false,
                    italic: false,
                    code: false
                },
            ]
        );
        assert_eq!(plain("**Bold** and _it_"), "Bold and it");
    }
}
