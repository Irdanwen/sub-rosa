//! The small readings every statement format shares: bytes to text in
//! whatever encoding the bank chose, an amount as written in Zurich, Lyon or
//! a spreadsheet, and a date in any of the three orders banks use.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// Statements arrive as UTF-8, UTF-8 with a byte order mark, UTF-16 from a
/// spreadsheet's "Unicode text", or Windows-1252 (the French banks' and
/// PostFinance's older exports). Anything that is not valid UTF-8 is read as
/// Windows-1252, which maps every byte, so nothing is refused for encoding.
pub fn decode(bytes: &[u8]) -> String {
    if let Some((encoding, bom)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = encoding.decode_without_bom_handling(&bytes[bom..]);
        return text.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
    }
}

/// Lowercase, without accents or surrounding punctuation, one space between
/// words: how a column header is compared with the names a bank gives it.
pub fn normalize(text: &str) -> String {
    let folded: String = text
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'ç' => 'c',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ñ' => 'n',
            'ò' | 'ó' | 'ô' | 'ö' | 'õ' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            '\u{a0}' | '\u{202f}' | '\t' => ' ',
            other => other,
        })
        .collect();
    folded
        .trim_matches(|c: char| c.is_whitespace() || c == ':' || c == '"')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// One line of free text: no line breaks, no runs of spaces, bounded.
pub fn clean(text: &str, max_chars: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

/// Parses an amount into signed minor units (cents). Understands `-1'234.50`,
/// `1 234,50`, `1.234,50`, `45.50-`, `(45.50)`, `−12,00 €` and `CHF 12.-`.
/// When both separators appear the last one is the decimal one. A single
/// separator is the decimal one when it appears once and is the statement's
/// own (`decimal_comma`), or is followed by one or two digits; otherwise it
/// groups thousands.
pub fn parse_amount(text: &str, decimal_comma: bool) -> Option<i64> {
    let trimmed = text.trim();
    // Swiss prices write whole francs as `12.-`.
    let trimmed = trimmed.strip_suffix(".-").unwrap_or(trimmed);
    let negative = trimmed.starts_with('-')
        || trimmed.starts_with('\u{2212}')
        || trimmed.ends_with('-')
        || (trimmed.starts_with('(') && trimmed.ends_with(')'));
    let kept: String = trimmed
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
        .collect();
    if !kept.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let decimal = match (kept.rfind('.'), kept.rfind(',')) {
        (Some(dot), Some(comma)) => Some(dot.max(comma)),
        (Some(at), None) | (None, Some(at)) => {
            let separator = kept.as_bytes()[at] as char;
            let once = kept.matches(separator).count() == 1;
            let digits_after = kept.len() - at - 1;
            let configured = (separator == ',') == decimal_comma;
            (once && (configured || (1..=2).contains(&digits_after))).then_some(at)
        }
        (None, None) => None,
    };
    let (whole, fraction) = match decimal {
        Some(at) => (&kept[..at], &kept[at + 1..]),
        None => (kept.as_str(), ""),
    };
    let whole: String = whole.chars().filter(char::is_ascii_digit).collect();
    let fraction: String = fraction.chars().filter(char::is_ascii_digit).collect();
    let units: i64 = if whole.is_empty() {
        0
    } else {
        whole.parse().ok()?
    };
    // Cents, rounded half away from zero when a bank writes more digits.
    let mut digits = fraction.chars();
    let tens = digits.next().and_then(|c| c.to_digit(10)).unwrap_or(0) as i64;
    let ones = digits.next().and_then(|c| c.to_digit(10)).unwrap_or(0) as i64;
    let round_up = digits.next().and_then(|c| c.to_digit(10)).unwrap_or(0) >= 5;
    let minor = units
        .checked_mul(100)?
        .checked_add(tens * 10 + ones + i64::from(round_up))?;
    Some(if negative { -minor } else { minor })
}

/// The order of day, month and year in a statement's dates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DateOrder {
    Dmy,
    Ymd,
    Mdy,
}

/// Parses `15.03.2024`, `15/03/24`, `2024-03-15 00:00:00.0`, `20240315` or
/// `="2024-03-15"`. A four-digit first group is always a year.
pub fn parse_date(text: &str, order: DateOrder) -> Option<NaiveDate> {
    let groups: Vec<&str> = text
        .split(|c: char| !c.is_ascii_digit())
        .filter(|group| !group.is_empty())
        .collect();
    let first = *groups.first()?;
    if first.len() >= 8 {
        // OFX and compact exports: YYYYMMDD[HHMMSS].
        let year = first.get(0..4)?.parse().ok()?;
        let month = first.get(4..6)?.parse().ok()?;
        let day = first.get(6..8)?.parse().ok()?;
        return NaiveDate::from_ymd_opt(year, month, day);
    }
    if groups.len() < 3 {
        return None;
    }
    let number = |group: &str| group.parse::<u32>().ok();
    let year = |group: &str| -> Option<i32> {
        let value: i32 = group.parse().ok()?;
        match group.len() {
            2 => Some(2000 + value),
            4 => Some(value),
            _ => None,
        }
    };
    let (y, m, d) = if first.len() == 4 {
        (year(groups[0])?, number(groups[1])?, number(groups[2])?)
    } else {
        match order {
            DateOrder::Dmy | DateOrder::Ymd => {
                (year(groups[2])?, number(groups[1])?, number(groups[0])?)
            }
            DateOrder::Mdy => (year(groups[2])?, number(groups[0])?, number(groups[1])?),
        }
    };
    NaiveDate::from_ymd_opt(y, m, d)
}

/// The order that reads every sample: a four-digit first group is a year, a
/// first group above twelve is a day, a second above twelve means the month
/// came first. Otherwise day first, as every bank this app knows writes it.
pub fn guess_date_order<'a>(samples: impl IntoIterator<Item = &'a str>) -> DateOrder {
    let mut day_first = false;
    let mut month_first = false;
    for sample in samples {
        let groups: Vec<u32> = sample
            .split(|c: char| !c.is_ascii_digit())
            .filter(|group| !group.is_empty())
            .take(3)
            .filter_map(|group| {
                if group.len() <= 4 {
                    group.parse().ok()
                } else {
                    None
                }
            })
            .collect();
        match groups.as_slice() {
            [first, ..] if *first > 31 => return DateOrder::Ymd,
            [first, ..] if *first > 12 => day_first = true,
            [_, second, ..] if *second > 12 => month_first = true,
            _ => {}
        }
    }
    if month_first && !day_first {
        DateOrder::Mdy
    } else {
        DateOrder::Dmy
    }
}

/// Whether the amounts in a column are written with a decimal comma.
pub fn guess_decimal_comma<'a>(samples: impl IntoIterator<Item = &'a str>) -> bool {
    let (mut comma, mut point) = (0, 0);
    for sample in samples {
        let kept: String = sample
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
            .collect();
        match (kept.rfind('.'), kept.rfind(',')) {
            (Some(dot), Some(at)) if at > dot => comma += 1,
            (Some(_), Some(_)) => point += 1,
            (None, Some(at)) if kept.len() - at - 1 <= 2 => comma += 1,
            (Some(at), None) if kept.len() - at - 1 <= 2 => point += 1,
            _ => {}
        }
    }
    comma > point
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_as_banks_write_them() {
        assert_eq!(parse_amount("-1'234.50", false), Some(-123_450));
        assert_eq!(parse_amount("1’234.50", false), Some(123_450));
        assert_eq!(parse_amount("1 234,50", true), Some(123_450));
        assert_eq!(parse_amount("1.234,50", true), Some(123_450));
        assert_eq!(parse_amount("-45,50", false), Some(-4_550));
        assert_eq!(parse_amount("45.50-", false), Some(-4_550));
        assert_eq!(parse_amount("(45.50)", false), Some(-4_550));
        assert_eq!(parse_amount("\u{2212}12,00 €", true), Some(-1_200));
        assert_eq!(parse_amount("CHF 12.-", false), Some(1_200));
        assert_eq!(parse_amount("1,234", false), Some(123_400));
        assert_eq!(parse_amount("12.345", false), Some(1_235));
        assert_eq!(parse_amount("1.234", true), Some(123_400));
        assert_eq!(parse_amount("0,125", true), Some(13));
        assert_eq!(parse_amount("7", false), Some(700));
        assert_eq!(parse_amount("", false), None);
        assert_eq!(parse_amount("n/a", false), None);
    }

    #[test]
    fn dates_in_every_order() {
        let march = NaiveDate::from_ymd_opt(2024, 3, 15);
        assert_eq!(parse_date("15.03.2024", DateOrder::Dmy), march);
        assert_eq!(parse_date("15/03/24", DateOrder::Dmy), march);
        assert_eq!(parse_date("2024-03-15 00:00:00.0", DateOrder::Dmy), march);
        assert_eq!(parse_date("=\"2024-03-15\"", DateOrder::Dmy), march);
        assert_eq!(parse_date("20240315", DateOrder::Dmy), march);
        assert_eq!(
            parse_date("20240315120000.000[-5:EST]", DateOrder::Dmy),
            march
        );
        assert_eq!(parse_date("03/15/2024", DateOrder::Mdy), march);
        assert_eq!(parse_date("31.02.2024", DateOrder::Dmy), None);
        assert_eq!(parse_date("Total", DateOrder::Dmy), None);
    }

    #[test]
    fn the_order_and_the_decimal_are_read_from_samples() {
        assert_eq!(
            guess_date_order(["01.02.2024", "28.02.2024"]),
            DateOrder::Dmy
        );
        assert_eq!(guess_date_order(["02/28/2024"]), DateOrder::Mdy);
        assert_eq!(guess_date_order(["2024-02-28"]), DateOrder::Ymd);
        assert!(guess_decimal_comma(["-12,50", "1 234,00"]));
        assert!(!guess_decimal_comma(["-12.50", "1'234.00"]));
    }

    #[test]
    fn text_in_any_encoding() {
        assert_eq!(decode("Libellé".as_bytes()), "Libellé");
        assert_eq!(decode(b"\xEF\xBB\xBFDate"), "Date");
        assert_eq!(decode(b"Libell\xe9"), "Libellé");
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("Débit".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(decode(&utf16), "Débit");
        assert_eq!(normalize("  Débit en CHF: "), "debit en chf");
    }
}
