//! A deck as a PowerPoint file (`.pptx`), written by hand.
//!
//! PresentationML (ECMA-376) needs more scaffolding than a document: a
//! presentation part, a slide master with one layout, a theme, and for
//! speaker notes a notes master with its own theme. That scaffolding is fixed,
//! so it is a template here (`pptx_parts.rs`); what varies is the slides, and
//! they come in five shapes the assistant can ask for:
//!
//! - **title**: a centred title and an optional subtitle (also a section break);
//! - **bullets**: a title over a bulleted list, with nested levels;
//! - **two_column**: a title over two lists, each with an optional heading;
//! - **image**: a title over a picture from the gallery, fitted without
//!   distortion, with a caption that is also its alternative text, and
//!   bullets beside it when there are any;
//! - every slide may carry **speaker notes**.
//!
//! Text boxes are placed explicitly rather than inherited from layout
//! placeholders, so the file looks the same in every reader. Inline marks
//! (`**bold**`, `*italic*`) are read with the Word writer's parser, so the
//! assistant writes one dialect for both.

use serde_json::Value;

use super::pptx_parts as parts;
use super::{invalid, xml_text, SlideImage};
use crate::docx::{parse_inline, Inline};
use crate::domain::types::AppError;

const MAX_SLIDES: usize = 60;
const MAX_BULLETS: usize = 14;
const MAX_TEXT: usize = 2_000;
const MAX_NOTES: usize = 8_000;

/// 13.333 by 7.5 inches: the 16:9 slide every current reader defaults to.
pub(super) const SLIDE_WIDTH: i64 = 12_192_000;
pub(super) const SLIDE_HEIGHT: i64 = 6_858_000;
const MARGIN: i64 = 548_640;
const TITLE_TOP: i64 = 365_760;
const TITLE_HEIGHT: i64 = 1_097_280;
const BODY_TOP: i64 = 1_554_480;
const GAP: i64 = 365_760;

#[derive(Debug, Clone, PartialEq)]
enum Layout {
    Title,
    Bullets,
    TwoColumn,
    Image,
}

#[derive(Debug, Clone, PartialEq)]
struct Bullet {
    text: String,
    level: u8,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Column {
    heading: Option<String>,
    bullets: Vec<Bullet>,
}

#[derive(Debug, Clone, PartialEq)]
struct Slide {
    layout: Layout,
    title: String,
    subtitle: Option<String>,
    bullets: Vec<Bullet>,
    left: Column,
    right: Column,
    image: Option<String>,
    caption: Option<String>,
    notes: Option<String>,
}

/// The `.pptx` bytes for a deck described as JSON, with the warnings the tool
/// passes on (a picture that could not be used).
///
/// `content` is `{slides: [...]}` or the slides array. A slide is
/// `{layout?, title, subtitle?, bullets?, left?, right?, image?, caption?,
/// notes?}`; `bullets` items are strings or `{text, level}`; `left`/`right`
/// are `{heading?, bullets}` or a bullets array; `image` names a gallery
/// picture. Without a layout one is inferred from what the slide holds.
pub(super) fn build(
    title: &str,
    content: &Value,
    images: &dyn Fn(&str) -> Result<SlideImage, String>,
) -> Result<(Vec<u8>, Vec<String>), AppError> {
    let slides = parse_slides(content)?;
    let mut warnings = Vec::new();
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut media: Vec<(String, Vec<u8>)> = Vec::new();
    let mut has_notes = false;
    for (index, slide) in slides.iter().enumerate() {
        let number = index + 1;
        let mut rels = vec![(
            "slideLayout".to_string(),
            "../slideLayouts/slideLayout1.xml".to_string(),
        )];
        let picture = match slide.image.as_deref() {
            Some(reference) => match images(reference) {
                Ok(image) => {
                    let name = format!("image{}.{}", media.len() + 1, image.extension);
                    rels.push(("image".to_string(), format!("../media/{name}")));
                    let embed = format!("rId{}", rels.len());
                    media.push((format!("ppt/media/{name}"), image.bytes.clone()));
                    Some((embed, image))
                }
                Err(reason) => {
                    warnings.push(format!("Slide {number}: {reason}"));
                    None
                }
            },
            None => None,
        };
        if slide.notes.is_some() {
            has_notes = true;
            rels.push((
                "notesSlide".to_string(),
                format!("../notesSlides/notesSlide{number}.xml"),
            ));
        }
        files.push((
            format!("ppt/slides/slide{number}.xml"),
            slide_xml(slide, picture.as_ref()).into_bytes(),
        ));
        files.push((
            format!("ppt/slides/_rels/slide{number}.xml.rels"),
            rels_xml(&rels).into_bytes(),
        ));
        if let Some(notes) = &slide.notes {
            files.push((
                format!("ppt/notesSlides/notesSlide{number}.xml"),
                notes_xml(notes).into_bytes(),
            ));
            files.push((
                format!("ppt/notesSlides/_rels/notesSlide{number}.xml.rels"),
                rels_xml(&[
                    (
                        "notesMaster".to_string(),
                        "../notesMasters/notesMaster1.xml".to_string(),
                    ),
                    ("slide".to_string(), format!("../slides/slide{number}.xml")),
                ])
                .into_bytes(),
            ));
        }
    }
    let count = slides.len();
    let mut package: Vec<(String, Vec<u8>)> = vec![
        (
            "[Content_Types].xml".into(),
            content_types(&slides, has_notes).into_bytes(),
        ),
        ("_rels/.rels".into(), parts::ROOT_RELS.as_bytes().to_vec()),
        (
            "docProps/core.xml".into(),
            super::core_xml(title).into_bytes(),
        ),
        (
            "ppt/presentation.xml".into(),
            presentation_xml(count, has_notes).into_bytes(),
        ),
        (
            "ppt/_rels/presentation.xml.rels".into(),
            presentation_rels(count, has_notes).into_bytes(),
        ),
        (
            "ppt/slideMasters/slideMaster1.xml".into(),
            parts::SLIDE_MASTER.as_bytes().to_vec(),
        ),
        (
            "ppt/slideMasters/_rels/slideMaster1.xml.rels".into(),
            parts::SLIDE_MASTER_RELS.as_bytes().to_vec(),
        ),
        (
            "ppt/slideLayouts/slideLayout1.xml".into(),
            parts::SLIDE_LAYOUT.as_bytes().to_vec(),
        ),
        (
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels".into(),
            parts::SLIDE_LAYOUT_RELS.as_bytes().to_vec(),
        ),
        (
            "ppt/theme/theme1.xml".into(),
            parts::THEME.as_bytes().to_vec(),
        ),
        (
            "ppt/presProps.xml".into(),
            parts::PRES_PROPS.as_bytes().to_vec(),
        ),
        (
            "ppt/viewProps.xml".into(),
            parts::VIEW_PROPS.as_bytes().to_vec(),
        ),
        (
            "ppt/tableStyles.xml".into(),
            parts::TABLE_STYLES.as_bytes().to_vec(),
        ),
    ];
    if has_notes {
        package.push((
            "ppt/notesMasters/notesMaster1.xml".into(),
            parts::NOTES_MASTER.as_bytes().to_vec(),
        ));
        package.push((
            "ppt/notesMasters/_rels/notesMaster1.xml.rels".into(),
            parts::NOTES_MASTER_RELS.as_bytes().to_vec(),
        ));
        // A notes master needs a theme of its own; sharing the slide
        // master's makes PowerPoint repair the file.
        package.push((
            "ppt/theme/theme2.xml".into(),
            parts::THEME.as_bytes().to_vec(),
        ));
    }
    package.extend(files);
    package.extend(media);
    Ok((super::package(&package)?, warnings))
}

fn parse_slides(content: &Value) -> Result<Vec<Slide>, AppError> {
    let raw = match content {
        Value::Array(slides) => slides,
        Value::Object(map) => match map.get("slides") {
            Some(Value::Array(slides)) => slides,
            _ => &Vec::new(),
        },
        _ => &Vec::new(),
    };
    let slides: Vec<Slide> = raw
        .iter()
        .take(MAX_SLIDES)
        .enumerate()
        .filter_map(|(index, value)| parse_slide(index, value))
        .collect();
    if slides.is_empty() {
        return Err(invalid(
            "A presentation needs content.slides, each with a title and bullets, columns or an image.",
        ));
    }
    Ok(slides)
}

fn parse_slide(index: usize, value: &Value) -> Option<Slide> {
    let map = value.as_object()?;
    let text = |key: &str| {
        map.get(key)
            .and_then(Value::as_str)
            .map(|s| capped(s, MAX_TEXT))
            .filter(|s| !s.is_empty())
    };
    let bullets = parse_bullets(map.get("bullets").or_else(|| map.get("points")));
    let left = parse_column(map.get("left"));
    let right = parse_column(map.get("right"));
    let image = text("image");
    let subtitle = text("subtitle");
    let layout = match map
        .get("layout")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_")
        .as_str()
    {
        "title" | "section" => Layout::Title,
        "two_column" | "two_columns" | "columns" | "comparison" => Layout::TwoColumn,
        "image" | "picture" => Layout::Image,
        "bullets" | "content" => Layout::Bullets,
        _ if image.is_some() => Layout::Image,
        _ if !left.bullets.is_empty() || !right.bullets.is_empty() => Layout::TwoColumn,
        _ if bullets.is_empty() && (index == 0 || subtitle.is_some()) => Layout::Title,
        _ => Layout::Bullets,
    };
    let title = text("title").unwrap_or_default();
    let notes = map
        .get("notes")
        .and_then(Value::as_str)
        .map(|s| capped(s, MAX_NOTES))
        .filter(|s| !s.is_empty());
    if title.is_empty()
        && subtitle.is_none()
        && bullets.is_empty()
        && left.bullets.is_empty()
        && right.bullets.is_empty()
        && image.is_none()
    {
        return None;
    }
    Some(Slide {
        layout,
        title,
        subtitle,
        bullets,
        left,
        right,
        image,
        caption: text("caption"),
        notes,
    })
}

fn parse_bullets(value: Option<&Value>) -> Vec<Bullet> {
    let Some(Value::Array(items)) = value else {
        return match value.and_then(Value::as_str) {
            // A paragraph given where a list was expected: one line per bullet.
            Some(text) => text
                .lines()
                .map(|line| line.trim().trim_start_matches(['-', '*', '•']).trim())
                .filter(|line| !line.is_empty())
                .take(MAX_BULLETS)
                .map(|line| Bullet {
                    text: capped(line, MAX_TEXT),
                    level: 0,
                })
                .collect(),
            None => Vec::new(),
        };
    };
    items
        .iter()
        .filter_map(|item| match item {
            Value::String(text) => Some(Bullet {
                text: capped(text, MAX_TEXT),
                level: 0,
            }),
            Value::Object(map) => Some(Bullet {
                text: capped(map.get("text").and_then(Value::as_str)?, MAX_TEXT),
                level: map
                    .get("level")
                    .and_then(Value::as_u64)
                    .map_or(0, |level| level.min(3) as u8),
            }),
            _ => None,
        })
        .filter(|bullet| !bullet.text.is_empty())
        .take(MAX_BULLETS)
        .collect()
}

fn parse_column(value: Option<&Value>) -> Column {
    match value {
        Some(Value::Object(map)) => Column {
            heading: map
                .get("heading")
                .or_else(|| map.get("title"))
                .and_then(Value::as_str)
                .map(|s| capped(s, MAX_TEXT))
                .filter(|s| !s.is_empty()),
            bullets: parse_bullets(map.get("bullets").or_else(|| map.get("points"))),
        },
        Some(other) => Column {
            heading: None,
            bullets: parse_bullets(Some(other)),
        },
        None => Column::default(),
    }
}

fn capped(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

/// Shapes are numbered from 2 (1 is the slide's own group).
struct Shapes {
    xml: String,
    next_id: u32,
}

impl Shapes {
    fn text_box(
        &mut self,
        name: &str,
        frame: (i64, i64, i64, i64),
        anchor: &str,
        paragraphs: &str,
    ) {
        let id = self.next_id;
        self.next_id += 1;
        let (x, y, cx, cy) = frame;
        self.xml.push_str(&format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name} {id}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap=\"square\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\" anchor=\"{anchor}\"><a:normAutofit/></a:bodyPr><a:lstStyle/>{paragraphs}</p:txBody></p:sp>"
        ));
    }

    fn picture(&mut self, embed: &str, image: &SlideImage, frame: (i64, i64, i64, i64), alt: &str) {
        let id = self.next_id;
        self.next_id += 1;
        let (x, y, cx, cy) = fit(image.width, image.height, frame);
        self.xml.push_str(&format!(
            "<p:pic><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"Picture {id}\" descr=\"{}\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed=\"{embed}\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
            xml_text(alt)
        ));
    }
}

/// The largest frame of the picture's proportions inside `frame`, centred.
fn fit(width: u32, height: u32, frame: (i64, i64, i64, i64)) -> (i64, i64, i64, i64) {
    let (x, y, cx, cy) = frame;
    if width == 0 || height == 0 {
        return frame;
    }
    let (w, h) = (i64::from(width), i64::from(height));
    // Compare cx/cy with w/h without floating point.
    let (fit_cx, fit_cy) = if cx * h <= cy * w {
        (cx, cx * h / w)
    } else {
        (cy * w / h, cy)
    };
    (x + (cx - fit_cx) / 2, y + (cy - fit_cy) / 2, fit_cx, fit_cy)
}

/// One paragraph of runs, its marks read from the text.
fn paragraph(text: &str, size: u32, bold: bool, align: Option<&str>, properties: &str) -> String {
    let mut runs = String::new();
    for inline in parse_inline(text) {
        let (text, marked_bold, italic) = match inline {
            Inline::Text {
                text, bold, italic, ..
            } => (text, bold, italic),
            Inline::Link { text, .. } => (text, false, false),
        };
        runs.push_str(&format!(
            "<a:r><a:rPr lang=\"en-US\" sz=\"{size}\"{}{} dirty=\"0\"/><a:t>{}</a:t></a:r>",
            if bold || marked_bold { " b=\"1\"" } else { "" },
            if italic { " i=\"1\"" } else { "" },
            xml_text(&text)
        ));
    }
    let align = align.map(|a| format!(" algn=\"{a}\"")).unwrap_or_default();
    if properties.is_empty() && align.is_empty() {
        format!("<a:p>{runs}</a:p>")
    } else {
        format!("<a:p><a:pPr{align}>{properties}</a:pPr>{runs}</a:p>")
    }
}

fn bullet_paragraphs(bullets: &[Bullet], size: u32) -> String {
    bullets
        .iter()
        .map(|bullet| {
            let level = i64::from(bullet.level);
            let properties = "<a:spcBef><a:spcPts val=\"600\"/></a:spcBef><a:buFont typeface=\"Arial\"/><a:buChar char=\"\u{2022}\"/>";
            let p = paragraph(
                &bullet.text,
                size.saturating_sub(200 * u32::from(bullet.level)),
                false,
                None,
                properties,
            );
            // Indent by level: the bullet hangs 0.3 inch left of its text.
            p.replacen(
                "<a:pPr>",
                &format!(
                    "<a:pPr marL=\"{}\" lvl=\"{level}\" indent=\"-285750\">",
                    285_750 + level * 457_200
                ),
                1,
            )
        })
        .collect()
}

fn slide_xml(slide: &Slide, picture: Option<&(String, SlideImage)>) -> String {
    let mut shapes = Shapes {
        xml: String::new(),
        next_id: 2,
    };
    let width = SLIDE_WIDTH - 2 * MARGIN;
    let body_height = SLIDE_HEIGHT - BODY_TOP - MARGIN;
    let title_frame = (MARGIN, TITLE_TOP, width, TITLE_HEIGHT);
    let heading = |shapes: &mut Shapes| {
        if !slide.title.is_empty() {
            shapes.text_box(
                "Title",
                title_frame,
                "b",
                &paragraph(&slide.title, 3200, true, None, ""),
            );
        }
    };
    match slide.layout {
        Layout::Title => {
            shapes.text_box(
                "Title",
                (MARGIN, 2_057_400, width, 1_600_200),
                "b",
                &paragraph(&slide.title, 4400, true, Some("ctr"), ""),
            );
            if let Some(subtitle) = &slide.subtitle {
                shapes.text_box(
                    "Subtitle",
                    (MARGIN, 3_749_040, width, 1_143_000),
                    "t",
                    &paragraph(subtitle, 2400, false, Some("ctr"), ""),
                );
            }
            if !slide.bullets.is_empty() {
                shapes.text_box(
                    "Text",
                    (MARGIN, 4_937_760, width, 1_371_600),
                    "t",
                    &bullet_paragraphs(&slide.bullets, 1800),
                );
            }
        }
        Layout::Bullets => {
            heading(&mut shapes);
            let mut body = bullet_paragraphs(&slide.bullets, 2400);
            if let Some(subtitle) = &slide.subtitle {
                body.insert_str(0, &paragraph(subtitle, 2000, false, None, ""));
            }
            if !body.is_empty() {
                shapes.text_box(
                    "Content",
                    (MARGIN, BODY_TOP, width, body_height),
                    "t",
                    &body,
                );
            }
        }
        Layout::TwoColumn => {
            heading(&mut shapes);
            let column_width = (width - GAP) / 2;
            for (offset, column) in [(0, &slide.left), (column_width + GAP, &slide.right)] {
                let mut body = String::new();
                if let Some(title) = &column.heading {
                    body.push_str(&paragraph(title, 2200, true, None, ""));
                }
                body.push_str(&bullet_paragraphs(&column.bullets, 2000));
                if !body.is_empty() {
                    shapes.text_box(
                        "Column",
                        (MARGIN + offset, BODY_TOP, column_width, body_height),
                        "t",
                        &body,
                    );
                }
            }
        }
        Layout::Image => {
            heading(&mut shapes);
            let caption_height = if slide.caption.is_some() { 457_200 } else { 0 };
            let picture_height = body_height - caption_height;
            // Bullets beside the picture take the left half.
            let (picture_left, picture_width) = if slide.bullets.is_empty() {
                (MARGIN, width)
            } else {
                let half = (width - GAP) / 2;
                shapes.text_box(
                    "Content",
                    (MARGIN, BODY_TOP, half, body_height),
                    "t",
                    &bullet_paragraphs(&slide.bullets, 2000),
                );
                (MARGIN + half + GAP, half)
            };
            let alt = slide.caption.as_deref().unwrap_or(slide.title.as_str());
            if let Some((embed, image)) = picture {
                shapes.picture(
                    embed,
                    image,
                    (picture_left, BODY_TOP, picture_width, picture_height),
                    alt,
                );
            }
            if let Some(caption) = &slide.caption {
                shapes.text_box(
                    "Caption",
                    (
                        picture_left,
                        BODY_TOP + picture_height,
                        picture_width,
                        caption_height,
                    ),
                    "t",
                    &paragraph(caption, 1400, false, Some("ctr"), ""),
                );
            }
        }
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:sld {}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
        parts::NS,
        shapes.xml
    )
}

fn notes_xml(notes: &str) -> String {
    let paragraphs: String = notes
        .lines()
        .map(|line| {
            format!(
                "<a:p><a:r><a:rPr lang=\"en-US\" dirty=\"0\"/><a:t>{}</a:t></a:r></a:p>",
                xml_text(line)
            )
        })
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:notes {}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Slide Image Placeholder 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"sldImg\"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Notes Placeholder 2\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>",
        parts::NS,
        if paragraphs.is_empty() { "<a:p/>".to_string() } else { paragraphs }
    )
}

fn rels_xml(rels: &[(String, String)]) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    );
    for (index, (kind, target)) in rels.iter().enumerate() {
        xml.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}\" Target=\"{target}\"/>",
            index + 1
        ));
    }
    xml.push_str("</Relationships>");
    xml
}

fn presentation_xml(slides: usize, notes: bool) -> String {
    let mut ids = String::new();
    for n in 0..slides {
        ids.push_str(&format!(
            "<p:sldId id=\"{}\" r:id=\"rId{}\"/>",
            256 + n,
            n + 2
        ));
    }
    let notes_master = if notes {
        format!(
            "<p:notesMasterIdLst><p:notesMasterId r:id=\"rId{}\"/></p:notesMasterIdLst>",
            slides + 2
        )
    } else {
        String::new()
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:presentation {} saveSubsetFonts=\"1\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>{notes_master}<p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx=\"{SLIDE_WIDTH}\" cy=\"{SLIDE_HEIGHT}\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/><p:defaultTextStyle><a:defPPr><a:defRPr lang=\"en-US\"/></a:defPPr></p:defaultTextStyle></p:presentation>",
        parts::NS
    )
}

fn presentation_rels(slides: usize, notes: bool) -> String {
    let mut rels = vec![(
        "slideMaster".to_string(),
        "slideMasters/slideMaster1.xml".to_string(),
    )];
    for n in 1..=slides {
        rels.push(("slide".to_string(), format!("slides/slide{n}.xml")));
    }
    if notes {
        rels.push((
            "notesMaster".to_string(),
            "notesMasters/notesMaster1.xml".to_string(),
        ));
    }
    for (kind, target) in [
        ("presProps", "presProps.xml"),
        ("viewProps", "viewProps.xml"),
        ("theme", "theme/theme1.xml"),
        ("tableStyles", "tableStyles.xml"),
    ] {
        rels.push((kind.to_string(), target.to_string()));
    }
    rels_xml(&rels)
}

fn content_types(slides: &[Slide], notes: bool) -> String {
    let main = "application/vnd.openxmlformats-officedocument.presentationml";
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/><Default Extension=\"gif\" ContentType=\"image/gif\"/><Override PartName=\"/ppt/presentation.xml\" ContentType=\"{main}.presentation.main+xml\"/><Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"{main}.slideMaster+xml\"/><Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"{main}.slideLayout+xml\"/><Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/><Override PartName=\"/ppt/presProps.xml\" ContentType=\"{main}.presProps+xml\"/><Override PartName=\"/ppt/viewProps.xml\" ContentType=\"{main}.viewProps+xml\"/><Override PartName=\"/ppt/tableStyles.xml\" ContentType=\"{main}.tableStyles+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>"
    );
    if notes {
        xml.push_str(&format!(
            "<Override PartName=\"/ppt/notesMasters/notesMaster1.xml\" ContentType=\"{main}.notesMaster+xml\"/><Override PartName=\"/ppt/theme/theme2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>"
        ));
    }
    for (index, slide) in slides.iter().enumerate() {
        let n = index + 1;
        xml.push_str(&format!(
            "<Override PartName=\"/ppt/slides/slide{n}.xml\" ContentType=\"{main}.slide+xml\"/>"
        ));
        if slide.notes.is_some() {
            xml.push_str(&format!(
                "<Override PartName=\"/ppt/notesSlides/notesSlide{n}.xml\" ContentType=\"{main}.notesSlide+xml\"/>"
            ));
        }
    }
    xml.push_str("</Types>");
    xml
}

#[cfg(test)]
mod tests {
    use super::super::tests_support::{assert_valid_package, part, part_names};
    use super::*;
    use serde_json::json;

    fn png(width: u32, height: u32) -> SlideImage {
        SlideImage {
            bytes: b"\x89PNG\r\n\x1a\nfake".to_vec(),
            extension: "png",
            width,
            height,
        }
    }

    fn deck() -> Value {
        json!({"slides": [
            {"title": "Quarterly review", "subtitle": "October & beyond"},
            {"title": "Highlights", "bullets": ["Revenue **up** 12%", {"text": "EMEA led", "level": 1}], "notes": "Pause here.\nThen ask for questions."},
            {"layout": "two_column", "title": "Before and after", "left": {"heading": "Before", "bullets": ["Manual"]}, "right": ["Automated", "Audited"]},
            {"title": "The new office", "image": "abc.png", "caption": "Ground floor <lobby>"},
            {"title": "Missing picture", "image": "gone.png", "bullets": ["Still a slide"]}
        ]})
    }

    fn resolver(reference: &str) -> Result<SlideImage, String> {
        if reference == "abc.png" {
            Ok(png(1600, 900))
        } else {
            Err(format!("{reference} is not in the gallery"))
        }
    }

    #[test]
    fn a_deck_has_its_slides_notes_and_picture() {
        let (bytes, warnings) = build("Review", &deck(), &resolver).unwrap();
        assert_eq!(warnings, vec!["Slide 5: gone.png is not in the gallery"]);
        assert_valid_package(&bytes);
        let names = part_names(&bytes);
        for n in 1..=5 {
            assert!(names.contains(&format!("ppt/slides/slide{n}.xml")));
        }
        assert!(names.contains(&"ppt/media/image1.png".to_string()));
        assert!(names.contains(&"ppt/notesSlides/notesSlide2.xml".to_string()));
        assert!(!names.contains(&"ppt/notesSlides/notesSlide1.xml".to_string()));
        assert!(names.contains(&"ppt/theme/theme2.xml".to_string()));

        let presentation = part(&bytes, "ppt/presentation.xml");
        assert_eq!(presentation.matches("<p:sldId ").count(), 5);
        assert!(presentation.contains("<p:notesMasterId r:id=\"rId7\"/>"));

        let title = part(&bytes, "ppt/slides/slide1.xml");
        assert!(title.contains("algn=\"ctr\""));
        assert!(title.contains("October &amp; beyond"));

        let bullets = part(&bytes, "ppt/slides/slide2.xml");
        assert!(bullets.contains("<a:buChar char=\"\u{2022}\"/>"));
        assert!(bullets.contains("b=\"1\" dirty=\"0\"/><a:t>up</a:t>"));
        assert!(bullets.contains("lvl=\"1\""));
        let notes = part(&bytes, "ppt/notesSlides/notesSlide2.xml");
        assert!(notes.contains("<a:t>Pause here.</a:t>"));
        assert!(notes.contains("<p:ph type=\"body\" idx=\"1\"/>"));
        assert!(part(&bytes, "ppt/slides/_rels/slide2.xml.rels").contains("notesSlide2.xml"));

        let columns = part(&bytes, "ppt/slides/slide3.xml");
        assert_eq!(columns.matches("name=\"Column ").count(), 2);
        assert!(columns.contains("<a:t>Before</a:t>"));

        let picture = part(&bytes, "ppt/slides/slide4.xml");
        assert!(picture.contains("<a:blip r:embed=\"rId2\"/>"));
        assert!(picture.contains("descr=\"Ground floor &lt;lobby&gt;\""));
        assert!(part(&bytes, "ppt/slides/_rels/slide4.xml.rels").contains("../media/image1.png"));
        // A missing picture leaves the slide, without a dangling relationship.
        assert!(!part(&bytes, "ppt/slides/slide5.xml").contains("<p:pic>"));
        assert!(part(&bytes, "ppt/slides/slide5.xml").contains("Still a slide"));
    }

    #[test]
    fn a_deck_without_notes_has_no_notes_master() {
        let (bytes, _) = build("x", &json!([{"title": "Only"}]), &resolver).unwrap();
        assert_valid_package(&bytes);
        assert!(!part_names(&bytes).iter().any(|name| name.contains("notes")));
        assert!(!part(&bytes, "ppt/presentation.xml").contains("notesMasterIdLst"));
        assert!(build("x", &json!({"slides": [{}]}), &resolver).is_err());
    }

    #[test]
    fn a_picture_keeps_its_proportions() {
        // Wide picture in a tall box: full width, centred vertically.
        assert_eq!(fit(200, 100, (0, 0, 1000, 1000)), (0, 250, 1000, 500));
        // Tall picture in a wide box: full height, centred horizontally.
        assert_eq!(fit(100, 200, (10, 0, 1000, 1000)), (260, 0, 500, 1000));
        assert_eq!(fit(0, 0, (1, 2, 3, 4)), (1, 2, 3, 4));
    }
}
