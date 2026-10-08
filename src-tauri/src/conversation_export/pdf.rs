//! A conversation's Markdown laid out as a PDF, with no renderer behind it.
//!
//! The phone's webviews cannot print (`window.print()` does nothing in
//! WKWebView or the Android WebView), so the PDF is drawn here, the same on
//! every platform (ADR-0082). It uses the four PDF base fonts (Helvetica,
//! bold, oblique, Courier), which every reader ships, so nothing is embedded
//! and the file stays small. Their WinAnsi encoding covers English, French
//! and the other Western European languages; a character outside it is
//! dropped when it is an emoji and printed as `?` otherwise. The Markdown
//! export keeps every character.
//!
//! What it understands is what the conversation export writes: headings,
//! paragraphs, list items, quotes, rules and fenced code. Inline emphasis is
//! dropped and a link prints as its text followed by its address.

/// A4, in points.
const PAGE_WIDTH: f32 = 595.28;
const PAGE_HEIGHT: f32 = 841.89;
const MARGIN_X: f32 = 56.0;
const MARGIN_TOP: f32 = 64.0;
const MARGIN_BOTTOM: f32 = 64.0;

/// Helvetica advance widths for WinAnsi codes 32 to 255, from the font's AFM.
const HELVETICA: [u16; 224] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
    350, 556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350,
    222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667, 278, 333, 556,
    556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556,
    537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667,
    667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722,
    722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278,
    278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

/// Helvetica-Bold advance widths for WinAnsi codes 32 to 255.
const HELVETICA_BOLD: [u16; 224] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
    611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
    278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
    350, 556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350,
    278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 350, 500, 667, 278, 333, 556,
    556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611,
    556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667,
    667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722,
    722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278,
    278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Font {
    Regular,
    Bold,
    Oblique,
    Mono,
}

impl Font {
    fn resource(self) -> &'static str {
        match self {
            Font::Regular => "F1",
            Font::Bold => "F2",
            Font::Oblique => "F3",
            Font::Mono => "F4",
        }
    }

    /// Width of one encoded byte at size 1.
    fn advance(self, byte: u8) -> f32 {
        let index = usize::from(byte.saturating_sub(32));
        let units = match self {
            Font::Mono => 600,
            Font::Bold => HELVETICA_BOLD.get(index).copied().unwrap_or(556),
            Font::Regular | Font::Oblique => HELVETICA.get(index).copied().unwrap_or(556),
        };
        f32::from(units) / 1000.0
    }

    fn width(self, bytes: &[u8], size: f32) -> f32 {
        bytes.iter().map(|byte| self.advance(*byte)).sum::<f32>() * size
    }
}

/// The WinAnsi byte for a character, `None` to drop it.
fn win_ansi(c: char) -> Option<u8> {
    let code = u32::from(c);
    let mapped = match c {
        '\t' => b' ',
        '€' => 0x80,
        '‚' => 0x82,
        'ƒ' => 0x83,
        '„' => 0x84,
        '…' => 0x85,
        '†' => 0x86,
        '‡' => 0x87,
        'ˆ' => 0x88,
        '‰' => 0x89,
        'Š' => 0x8A,
        '‹' => 0x8B,
        'Œ' => 0x8C,
        'Ž' => 0x8E,
        '‘' => 0x91,
        '’' => 0x92,
        '“' => 0x93,
        '”' => 0x94,
        '•' => 0x95,
        '–' => 0x96,
        '—' => 0x97,
        '˜' => 0x98,
        '™' => 0x99,
        'š' => 0x9A,
        '›' => 0x9B,
        'œ' => 0x9C,
        'ž' => 0x9E,
        'Ÿ' => 0x9F,
        // Spaces French typography puts before ; : ! ? and inside « ».
        '\u{202F}' | '\u{2007}' => 0xA0,
        '\u{2000}'..='\u{200A}' => b' ',
        '−' | '‐' | '‑' => b'-',
        _ if (0x20..=0x7E).contains(&code) || (0xA0..=0xFF).contains(&code) => code as u8,
        // Emoji, pictographs, their selectors and joiners: dropped, a row of
        // question marks reads worse than nothing.
        _ if is_pictograph(code) => return None,
        _ if c.is_control() => return None,
        _ => b'?',
    };
    Some(mapped)
}

fn is_pictograph(code: u32) -> bool {
    matches!(code,
        0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0x2190..=0x21FF
        | 0x2300..=0x23FF | 0x25A0..=0x25FF | 0xFE00..=0xFE0F | 0x200B..=0x200D
        | 0xE0020..=0xE007F)
}

fn encode(text: &str) -> Vec<u8> {
    text.chars().filter_map(win_ansi).collect()
}

/// A literal PDF string: parentheses and backslashes escaped, anything
/// outside printable ASCII as an octal escape so the file stays ASCII.
fn pdf_string(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() + 2);
    out.push('(');
    for byte in bytes {
        match byte {
            b'(' | b')' | b'\\' => {
                out.push('\\');
                out.push(char::from(*byte));
            }
            0x20..=0x7E => out.push(char::from(*byte)),
            _ => out.push_str(&format!("\\{byte:03o}")),
        }
    }
    out.push(')');
    out
}

/// Text for the document's Info dictionary, which may hold any character:
/// UTF-16BE with a byte order mark, as a hex string.
fn pdf_text_string(text: &str) -> String {
    let mut out = String::from("<FEFF");
    for unit in text.encode_utf16() {
        out.push_str(&format!("{unit:04X}"));
    }
    out.push('>');
    out
}

/// Inline Markdown as the reader sees it: emphasis and code marks gone, a
/// link as its text and its address.
fn plain_inline(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        // [label](url) -> label (url); ![alt](src) -> alt
        if c == '[' || (c == '!' && chars.get(index + 1) == Some(&'[')) {
            let image = c == '!';
            let open = if image { index + 1 } else { index };
            if let Some(close) = chars[open..].iter().position(|ch| *ch == ']') {
                let close = open + close;
                if chars.get(close + 1) == Some(&'(') {
                    if let Some(end) = chars[close + 1..].iter().position(|ch| *ch == ')') {
                        let end = close + 1 + end;
                        let label: String = chars[open + 1..close].iter().collect();
                        let url: String = chars[close + 2..end].iter().collect();
                        out.push_str(&label);
                        if !image && !url.is_empty() && url != label {
                            out.push_str(" (");
                            out.push_str(&url);
                            out.push(')');
                        }
                        index = end + 1;
                        continue;
                    }
                }
            }
        }
        if c == '`' {
            index += 1;
            continue;
        }
        if (c == '*' || c == '_' || c == '~')
            && (chars.get(index + 1) == Some(&c)
                || index == 0
                || !chars[index - 1].is_alphanumeric()
                || !chars
                    .get(index + 1)
                    .is_some_and(|next| next.is_alphanumeric()))
        {
            // Emphasis marks: a doubled mark, or one at a word boundary. A
            // mark inside a word (snake_case, 2*3) is text.
            index += if chars.get(index + 1) == Some(&c) {
                2
            } else {
                1
            };
            continue;
        }
        out.push(c);
        index += 1;
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Clone, PartialEq)]
enum Block {
    Heading(u8, String),
    Paragraph(String),
    /// A line wholly in emphasis, like the export's date and model line.
    Caption(String),
    /// Indent level, marker, text.
    Item(usize, String, String),
    Quote(String),
    Code(Vec<String>),
    Rule,
}

fn blocks(markdown: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut code: Option<Vec<String>> = None;
    for raw in markdown.replace("\r\n", "\n").lines() {
        let trimmed = raw.trim();
        if trimmed.starts_with("```") {
            match code.take() {
                Some(lines) => out.push(Block::Code(lines)),
                None => code = Some(Vec::new()),
            }
            continue;
        }
        if let Some(lines) = code.as_mut() {
            lines.push(raw.replace('\t', "    "));
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() >= 3
            && trimmed.chars().all(|c| c == '-' || c == '*' || c == '_')
            && trimmed
                .chars()
                .all(|c| c == trimmed.chars().next().unwrap_or('-'))
        {
            out.push(Block::Rule);
            continue;
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            out.push(Block::Heading(
                hashes as u8,
                plain_inline(&trimmed[hashes..]),
            ));
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('>') {
            out.push(Block::Quote(plain_inline(rest)));
            continue;
        }
        let indent = (raw.len() - raw.trim_start().len()) / 2;
        if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
        {
            out.push(Block::Item(indent, "•".into(), plain_inline(rest)));
            continue;
        }
        let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && digits < 4 {
            let rest = &trimmed[digits..];
            if let Some(text) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
                out.push(Block::Item(
                    indent,
                    format!("{}.", &trimmed[..digits]),
                    plain_inline(text),
                ));
                continue;
            }
        }
        let emphasised = |mark: char| {
            trimmed.len() > 2
                && trimmed.starts_with(mark)
                && trimmed.ends_with(mark)
                && !trimmed[1..].starts_with(mark)
        };
        if emphasised('*') || emphasised('_') {
            out.push(Block::Caption(plain_inline(trimmed)));
            continue;
        }
        out.push(Block::Paragraph(plain_inline(trimmed)));
    }
    if let Some(lines) = code {
        out.push(Block::Code(lines));
    }
    out
}

/// One positioned line of a page.
#[derive(Debug, Clone)]
enum Mark {
    Text {
        font: Font,
        size: f32,
        x: f32,
        y: f32,
        bytes: Vec<u8>,
        grey: bool,
    },
    Rule {
        y: f32,
    },
    Shade {
        y: f32,
        height: f32,
    },
}

/// Cuts encoded text into lines no wider than `width`, at spaces when it can.
fn wrap(bytes: &[u8], font: Font, size: f32, width: f32) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    for word in bytes
        .split(|byte| *byte == b' ')
        .filter(|word| !word.is_empty())
    {
        let candidate_width = if line.is_empty() {
            font.width(word, size)
        } else {
            font.width(&line, size) + font.advance(b' ') * size + font.width(word, size)
        };
        if candidate_width <= width {
            if !line.is_empty() {
                line.push(b' ');
            }
            line.extend_from_slice(word);
            continue;
        }
        if !line.is_empty() {
            lines.push(std::mem::take(&mut line));
        }
        // A word wider than the line (a long address) is cut where it must.
        let mut rest = word;
        while font.width(rest, size) > width {
            let mut cut = 1;
            while cut < rest.len() && font.width(&rest[..=cut], size) <= width {
                cut += 1;
            }
            lines.push(rest[..cut].to_vec());
            rest = &rest[cut..];
        }
        line.extend_from_slice(rest);
    }
    if !line.is_empty() || lines.is_empty() {
        lines.push(line);
    }
    lines
}

struct Layout {
    pages: Vec<Vec<Mark>>,
    y: f32,
}

impl Layout {
    fn new() -> Self {
        Self {
            pages: vec![Vec::new()],
            y: PAGE_HEIGHT - MARGIN_TOP,
        }
    }

    fn page(&mut self) -> &mut Vec<Mark> {
        if self.pages.is_empty() {
            self.pages.push(Vec::new());
        }
        let last = self.pages.len() - 1;
        &mut self.pages[last]
    }

    /// Moves down by `height`, starting a page first when it would not fit.
    fn advance(&mut self, height: f32) -> f32 {
        if self.y - height < MARGIN_BOTTOM {
            self.pages.push(Vec::new());
            self.y = PAGE_HEIGHT - MARGIN_TOP;
        }
        self.y -= height;
        self.y
    }

    /// Starts a new page unless `height` still fits on this one, so a
    /// heading never sits alone at the foot of a page.
    fn keep(&mut self, height: f32) {
        if self.y - height < MARGIN_BOTTOM {
            self.pages.push(Vec::new());
            self.y = PAGE_HEIGHT - MARGIN_TOP;
        }
    }

    fn gap(&mut self, height: f32) {
        // A gap at the top of a page is not drawn.
        if self.y < PAGE_HEIGHT - MARGIN_TOP {
            self.y -= height;
        }
    }

    /// Lays out wrapped text. Answers the page and baseline of its first
    /// line, where a list marker goes.
    fn text(&mut self, text: &str, font: Font, size: f32, indent: f32, grey: bool) -> (usize, f32) {
        let width = PAGE_WIDTH - 2.0 * MARGIN_X - indent;
        let mut first = None;
        for line in wrap(&encode(text), font, size, width) {
            let y = self.advance(size * 1.4) + size * 0.3;
            first.get_or_insert((self.pages.len() - 1, y));
            self.page().push(Mark::Text {
                font,
                size,
                x: MARGIN_X + indent,
                y,
                bytes: line,
                grey,
            });
        }
        first.unwrap_or((self.pages.len() - 1, self.y))
    }
}

fn lay_out(markdown: &str) -> Vec<Vec<Mark>> {
    let mut layout = Layout::new();
    for block in blocks(markdown) {
        match block {
            Block::Heading(level, text) => {
                let size = match level {
                    1 => 20.0,
                    2 => 13.0,
                    _ => 11.5,
                };
                layout.gap(if level == 1 { 16.0 } else { 12.0 });
                // The heading and the start of what it heads.
                layout.keep(size * 1.4 + 3.0 * 10.5 * 1.4);
                layout.text(&text, Font::Bold, size, 0.0, false);
                layout.gap(3.0);
            }
            Block::Paragraph(text) => {
                layout.text(&text, Font::Regular, 10.5, 0.0, false);
                layout.gap(3.0);
            }
            Block::Item(indent, marker, text) => {
                let x = 14.0 + 14.0 * indent as f32;
                // The marker sits on the item's first line, wherever it landed.
                let (page, y) = layout.text(&text, Font::Regular, 10.5, x, false);
                layout.pages[page].push(Mark::Text {
                    font: Font::Regular,
                    size: 10.5,
                    x: MARGIN_X + x - 11.0,
                    y,
                    bytes: encode(&marker),
                    grey: false,
                });
                layout.gap(1.5);
            }
            Block::Caption(text) => {
                layout.text(&text, Font::Oblique, 9.5, 0.0, true);
                layout.gap(3.0);
            }
            Block::Quote(text) => {
                layout.text(&text, Font::Oblique, 10.5, 14.0, true);
                layout.gap(3.0);
            }
            Block::Code(lines) => {
                layout.gap(2.0);
                for line in lines {
                    let size = 8.5;
                    let width = PAGE_WIDTH - 2.0 * MARGIN_X - 12.0;
                    for piece in wrap_mono(&encode(&line), size, width) {
                        let y = layout.advance(size * 1.45);
                        let page = layout.page();
                        page.push(Mark::Shade {
                            y,
                            height: size * 1.45,
                        });
                        page.push(Mark::Text {
                            font: Font::Mono,
                            size,
                            x: MARGIN_X + 6.0,
                            y: y + size * 0.35,
                            bytes: piece,
                            grey: false,
                        });
                    }
                }
                layout.gap(5.0);
            }
            Block::Rule => {
                layout.gap(4.0);
                let y = layout.advance(8.0);
                layout.page().push(Mark::Rule { y: y + 4.0 });
            }
        }
    }
    layout.pages
}

/// Code keeps its spaces: cut by character count, not at words.
fn wrap_mono(bytes: &[u8], size: f32, width: f32) -> Vec<Vec<u8>> {
    let per_line = ((width / (0.6 * size)).floor() as usize).max(1);
    if bytes.is_empty() {
        return vec![Vec::new()];
    }
    bytes.chunks(per_line).map(<[u8]>::to_vec).collect()
}

fn content_stream(marks: &[Mark], page: usize, pages: usize) -> String {
    let mut out = String::new();
    for mark in marks {
        match mark {
            Mark::Shade { y, height } => out.push_str(&format!(
                "0.95 g {:.2} {:.2} {:.2} {:.2} re f 0 g\n",
                MARGIN_X,
                y,
                PAGE_WIDTH - 2.0 * MARGIN_X,
                height
            )),
            Mark::Rule { y } => out.push_str(&format!(
                "0.8 G 0.5 w {:.2} {y:.2} m {:.2} {y:.2} l S 0 G\n",
                MARGIN_X,
                PAGE_WIDTH - MARGIN_X
            )),
            Mark::Text {
                font,
                size,
                x,
                y,
                bytes,
                grey,
            } => {
                if bytes.is_empty() {
                    continue;
                }
                let colour = if *grey { "0.35 g " } else { "" };
                out.push_str(&format!(
                    "BT {colour}/{} {size:.1} Tf {x:.2} {y:.2} Td {} Tj ET{}\n",
                    font.resource(),
                    pdf_string(bytes),
                    if *grey { " 0 g" } else { "" }
                ));
            }
        }
    }
    if pages > 1 {
        let number = encode(&format!("{page} / {pages}"));
        let x = (PAGE_WIDTH - Font::Regular.width(&number, 8.0)) / 2.0;
        out.push_str(&format!(
            "BT 0.5 g /F1 8.0 Tf {x:.2} {:.2} Td {} Tj ET 0 g\n",
            MARGIN_BOTTOM / 2.0,
            pdf_string(&number)
        ));
    }
    out
}

/// The whole file: catalog, page tree, the four base fonts, the document
/// information, then each page and its content stream.
pub fn markdown_to_pdf(title: &str, markdown: &str) -> Vec<u8> {
    let pages = lay_out(markdown);
    let count = pages.len().max(1);
    let mut objects: Vec<String> = Vec::new();
    // 1 catalog, 2 page tree, 3..=6 fonts, 7 info, then page/content pairs.
    let first_page = 8;
    let kids = (0..count)
        .map(|index| format!("{} 0 R", first_page + index * 2))
        .collect::<Vec<_>>()
        .join(" ");
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    objects.push(format!("<< /Type /Pages /Kids [{kids}] /Count {count} >>"));
    for base in [
        "Helvetica",
        "Helvetica-Bold",
        "Helvetica-Oblique",
        "Courier",
    ] {
        objects.push(format!(
            "<< /Type /Font /Subtype /Type1 /BaseFont /{base} /Encoding /WinAnsiEncoding >>"
        ));
    }
    objects.push(format!(
        "<< /Title {} /Producer {} >>",
        pdf_text_string(title.trim()),
        pdf_text_string("Sub Rosa")
    ));
    for (index, marks) in pages.iter().enumerate() {
        let content = content_stream(marks, index + 1, count);
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] \
             /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> \
             /Contents {} 0 R >>",
            first_page + index * 2 + 1
        ));
        objects.push(format!(
            "<< /Length {} >>\nstream\n{content}endstream",
            content.len()
        ));
    }

    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::with_capacity(objects.len());
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
    }
    let xref = out.len();
    out.push_str(&format!(
        "xref\n0 {}\n0000000000 65535 f \n",
        objects.len() + 1
    ));
    for offset in offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R /Info 7 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        objects.len() + 1
    ));
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(pdf: &[u8]) -> String {
        String::from_utf8(pdf.to_vec()).expect("the writer emits ASCII")
    }

    #[test]
    fn a_conversation_becomes_a_well_formed_pdf() {
        let pdf = markdown_to_pdf(
            "Trip to Lyon",
            "# Trip to Lyon\n\n*7 October 2026 · GLM 5.2*\n\n## You\n\nWhere should I eat?\n\n## Sub Rosa\n\nTry **Le Bouchon** near [the station](https://example.com/map).\n\n- Book ahead\n- Ask for the quenelles\n",
        );
        let text = text_of(&pdf);
        assert!(text.starts_with("%PDF-1.4\n"));
        assert!(text.ends_with("%%EOF\n"));
        assert!(text.contains("/BaseFont /Helvetica-Bold"));
        assert!(text.contains("(Where should I eat?) Tj"));
        // Emphasis is dropped, a link keeps its address.
        assert!(
            text.contains("(Try Le Bouchon near the station \\(https://example.com/map\\).) Tj")
        );
        assert!(text.contains("(Book ahead) Tj"));
        // The bullet is the WinAnsi bullet, written as an octal escape.
        assert!(text.contains("(\\225) Tj"));
        // Every xref offset points at its object.
        let xref_at: usize = text
            .rsplit("startxref\n")
            .next()
            .and_then(|tail| tail.lines().next())
            .and_then(|line| line.parse().ok())
            .expect("startxref");
        let table = &text[xref_at..];
        for (index, line) in table
            .lines()
            .skip(3)
            .take_while(|line| line.ends_with(" n "))
            .enumerate()
        {
            let offset: usize = line[..10].parse().expect("offset");
            assert!(text[offset..].starts_with(&format!("{} 0 obj", index + 1)));
        }
    }

    #[test]
    fn western_text_survives_and_the_rest_degrades_quietly() {
        assert_eq!(
            encode("Été, déjà « oui » – 5 €"),
            b"\xC9t\xE9, d\xE9j\xE0 \xAB oui \xBB \x96 5 \x80"
        );
        // Emoji vanish, another script prints as question marks.
        assert_eq!(encode("Done ✅🎉"), b"Done ");
        assert_eq!(encode("東京"), b"??");
        assert_eq!(pdf_string(b"a(b)\\"), "(a\\(b\\)\\\\)");
        assert_eq!(pdf_text_string("Été"), "<FEFF00C9007400E9>");
    }

    #[test]
    fn long_text_wraps_inside_the_margins_and_paginates() {
        let paragraph = "word ".repeat(400);
        let markdown = format!("# Long\n\n{}\n\n```\n{}\n```\n", paragraph, "x".repeat(300));
        let pages = lay_out(&markdown.repeat(4));
        assert!(pages.len() > 1, "four long blocks fill more than a page");
        let max = PAGE_WIDTH - MARGIN_X;
        for mark in pages.iter().flatten() {
            if let Mark::Text {
                font,
                size,
                x,
                y,
                bytes,
                ..
            } = mark
            {
                assert!(
                    x + font.width(bytes, *size) <= max + 0.5,
                    "a line overflows"
                );
                assert!(*y >= MARGIN_BOTTOM - 1.0 && *y <= PAGE_HEIGHT - MARGIN_TOP + 1.0);
            }
        }
        let pdf = text_of(&markdown_to_pdf("Long", &markdown.repeat(4)));
        assert!(pdf.contains(&format!("/Count {}", pages.len())));
        assert!(pdf.contains(&format!("(1 / {}) Tj", pages.len())));
    }

    #[test]
    fn a_heading_never_ends_a_page() {
        // Short turns, so headings land at every height of the page.
        let markdown = (0..120)
            .map(|index| format!("## Turn {index}\n\nOne line of reply.\n"))
            .collect::<String>();
        let pages = lay_out(&markdown);
        assert!(pages.len() > 2);
        for page in &pages[..pages.len() - 1] {
            let last = page.iter().rev().find_map(|mark| match mark {
                Mark::Text { font, .. } => Some(*font),
                _ => None,
            });
            assert_ne!(last, Some(Font::Bold), "a page ends on a heading");
        }
    }

    #[test]
    fn markdown_blocks_are_read_as_the_export_writes_them() {
        assert_eq!(
            blocks("## You\n\n1. First\n  - nested `code`\n> a quote\n---\n```\nlet x = 1;\n```"),
            vec![
                Block::Heading(2, "You".into()),
                Block::Item(0, "1.".into(), "First".into()),
                Block::Item(1, "•".into(), "nested code".into()),
                Block::Quote("a quote".into()),
                Block::Rule,
                Block::Code(vec!["let x = 1;".into()]),
            ]
        );
        assert_eq!(
            blocks("*7 October 2026 · GLM*\n**Bold line**"),
            vec![
                Block::Caption("7 October 2026 · GLM".into()),
                Block::Paragraph("Bold line".into()),
            ]
        );
        assert_eq!(
            plain_inline("snake_case and 2*3 stay"),
            "snake_case and 2*3 stay"
        );
        assert_eq!(
            plain_inline("![chart](a.png) **bold** _it_"),
            "chart bold it"
        );
    }
}
