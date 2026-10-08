//! Bank CSV exports: every bank its own columns, delimiter, decimal mark,
//! date order and preamble. Reading one is two steps. [`detect`] proposes a
//! [`CsvMapping`] (which column is the date, the amount, the description) and
//! names the bank when its header is recognised; the person checks or
//! corrects it in the import sheet; [`parse`] then reads every row with the
//! mapping the person confirmed. A row that cannot be read (a total line, a
//! blank, a footer) is counted, never guessed.

use super::text::{self, normalize, DateOrder};
use super::ParsedTransaction;
use serde::{Deserialize, Serialize};

/// How far into a file the header row may sit, after the bank's preamble
/// (account number, period, opening balance).
const HEADER_SEARCH_ROWS: usize = 40;
const SAMPLE_ROWS: usize = 5;
const MAX_DESCRIPTION: usize = 400;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvMapping {
    pub delimiter: String,
    /// The record (0-based) that holds the column names.
    pub header_row: usize,
    pub date: Option<usize>,
    pub date_order: DateOrder,
    /// Joined in order: banks spread a booking text over several columns.
    pub description: Vec<usize>,
    /// One signed amount column...
    pub amount: Option<usize>,
    /// ...or money out and money in in two columns, read without their sign.
    pub debit: Option<usize>,
    pub credit: Option<usize>,
    pub balance: Option<usize>,
    pub currency: Option<usize>,
    pub reference: Option<usize>,
    pub counterparty: Option<usize>,
    pub decimal_comma: bool,
    /// When no column names the currency.
    pub default_currency: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvLayout {
    /// The recognised bank, or `generic`.
    pub preset: String,
    pub mapping: CsvMapping,
    pub headers: Vec<String>,
    pub sample: Vec<Vec<String>>,
    /// An account number or IBAN found above the header.
    pub account: String,
}

/// The banks whose exports are recognised by their header. The names are
/// what the bank calls its columns, in each language it exports.
pub const PRESETS: &[&str] = &[
    "ubs",
    "postfinance",
    "raiffeisen",
    "bcv",
    "credit_agricole",
    "bnp",
    "generic",
];

const DATE: &[&str] = &[
    "booking date",
    "booked at",
    "buchungsdatum",
    "date de comptabilisation",
    "date comptable",
    "date operation",
    "date d'operation",
    "data contabile",
    "date",
    "datum",
    "data",
    "fecha",
    "transaction date",
    "date of transaction",
    "trade date",
    "abschlussdatum",
    "completed date",
    "started date",
];
const DESCRIPTION: &[&str] = &[
    "description1",
    "description2",
    "description3",
    "beschreibung1",
    "beschreibung2",
    "beschreibung3",
    "avisierungstext",
    "texte de notification",
    "testo di avviso",
    "notification text",
    "libelle",
    "libelle court",
    "libelle operation",
    "type operation",
    "description",
    "text",
    "buchungstext",
    "details",
    "motif",
    "descrizione",
    "verwendungszweck",
    "memo",
];
const AMOUNT: &[&str] = &[
    "amount",
    "montant",
    "betrag",
    "credit/debit amount",
    "montant operation",
    "montant operation en euro",
    "montant (eur)",
    "montant (chf)",
    "importo",
    "importe",
];
const DEBIT: &[&str] = &[
    "debit",
    "debit euros",
    "debit en chf",
    "debit chf",
    "debit (chf)",
    "lastschrift in chf",
    "lastschrift",
    "belastung",
    "addebito",
    "addebito in chf",
    "sortie",
];
const CREDIT: &[&str] = &[
    "credit",
    "credit euros",
    "credit en chf",
    "credit chf",
    "credit (chf)",
    "gutschrift in chf",
    "gutschrift",
    "accredito",
    "accredito in chf",
    "entree",
];
const BALANCE: &[&str] = &["balance", "saldo", "solde", "saldo in chf", "solde en chf"];
const CURRENCY: &[&str] = &["currency", "wahrung", "devise", "monnaie", "ccy", "divisa"];
const REFERENCE: &[&str] = &[
    "transaction no.",
    "transaktions-nr.",
    "reference",
    "referenz",
    "fitid",
    "numero de transaction",
];
const COUNTERPARTY: &[&str] = &[
    "counterparty",
    "beneficiary",
    "payee",
    "beneficiaire",
    "empfanger",
    "auftraggeber",
    "tiers",
];

fn find(headers: &[String], names: &[&str]) -> Option<usize> {
    names
        .iter()
        .find_map(|name| headers.iter().position(|header| header == name))
}

/// Splits CSV text into records: quoted fields may hold the delimiter, line
/// breaks and doubled quotes. Spreadsheet-escaped values (`="0042"`) lose
/// their escaping.
pub fn records(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' {
            quoted = true;
        } else if c == delimiter {
            row.push(cell(&field));
            field.clear();
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(cell(&field));
            field.clear();
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(cell(&field));
        rows.push(row);
    }
    // A blank line is one empty field: drop it, and any trailing empty cells
    // a delimiter at the end of every line leaves.
    rows.into_iter()
        .map(|mut row| {
            while row.last().is_some_and(String::is_empty) {
                row.pop();
            }
            row
        })
        .filter(|row| !row.is_empty())
        .collect()
}

fn cell(raw: &str) -> String {
    let trimmed = raw.trim();
    let trimmed = trimmed.strip_prefix('=').unwrap_or(trimmed);
    trimmed.trim_matches('"').trim().to_string()
}

/// The delimiter that splits the first lines most consistently.
pub fn guess_delimiter(text: &str) -> char {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(30)
        .collect();
    [';', ',', '\t', '|']
        .into_iter()
        .max_by_key(|candidate| {
            let mut counts: Vec<usize> = lines
                .iter()
                .map(|line| line.matches(*candidate).count())
                .collect();
            counts.sort_unstable();
            // The count most lines share, ties to the most lines having it.
            counts.get(counts.len() / 2).copied().unwrap_or(0)
        })
        .unwrap_or(';')
}

fn has_amount(headers: &[String]) -> bool {
    find(headers, AMOUNT).is_some()
        || find(headers, DEBIT).is_some()
        || find(headers, CREDIT).is_some()
}

/// Which bank wrote this header, from the column names only that bank uses.
fn preset_of(headers: &[String]) -> &'static str {
    let has = |name: &str| headers.iter().any(|header| header == name);
    if (has("description1") || has("beschreibung1"))
        && (has("trade date")
            || has("abschlussdatum")
            || has("date of transaction")
            || has("booking date"))
    {
        "ubs"
    } else if has("avisierungstext")
        || has("texte de notification")
        || has("testo di avviso")
        || has("notification text")
    {
        "postfinance"
    } else if has("booked at") && has("credit/debit amount") {
        "raiffeisen"
    } else if has("debit euros") || has("credit euros") {
        "credit_agricole"
    } else if has("libelle court") || has("montant operation") || has("montant operation en euro") {
        "bnp"
    } else if has("date valeur") && has("solde") && (has("debit") || has("credit")) {
        "bcv"
    } else {
        "generic"
    }
}

fn currency_of(preset: &str, headers: &[String]) -> String {
    if headers.iter().any(|header| header.contains("chf")) {
        return "CHF".into();
    }
    if headers.iter().any(|header| header.contains("eur")) {
        return "EUR".into();
    }
    match preset {
        "ubs" | "postfinance" | "raiffeisen" | "bcv" => "CHF".into(),
        "credit_agricole" | "bnp" => "EUR".into(),
        _ => String::new(),
    }
}

/// The value as an IBAN without its spaces, when it is one.
fn iban(value: &str) -> Option<String> {
    let compact: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    let looks_like = compact.len() >= 15
        && compact.len() <= 34
        && compact.chars().take(2).all(|c| c.is_ascii_uppercase())
        && compact.chars().skip(2).take(2).all(|c| c.is_ascii_digit())
        && compact.chars().all(|c| c.is_ascii_alphanumeric());
    looks_like.then_some(compact)
}

/// An IBAN (or the value next to an "account" label) above the header.
fn account_in(preamble: &[Vec<String>]) -> String {
    for row in preamble {
        for (at, value) in row.iter().enumerate() {
            if let Some(iban) = iban(value) {
                return iban;
            }
            let label = normalize(value);
            if [
                "account number",
                "kontonummer",
                "konto",
                "numero de compte",
                "compte",
                "iban",
            ]
            .contains(&label.as_str())
            {
                if let Some(next) = row.get(at + 1).filter(|next| !next.is_empty()) {
                    return iban(next).unwrap_or_else(|| text::clean(next, 64));
                }
            }
        }
    }
    String::new()
}

/// Proposes a mapping for the file. When no row looks like a header with a
/// date and an amount, the first row is taken as the header and the person
/// maps the columns by hand.
pub fn detect(content: &str) -> CsvLayout {
    let delimiter = guess_delimiter(content);
    let rows = records(content, delimiter);
    let header_row = rows.iter().take(HEADER_SEARCH_ROWS).position(|row| {
        let headers: Vec<String> = row.iter().map(|cell| normalize(cell)).collect();
        find(&headers, DATE).is_some() && has_amount(&headers)
    });
    let header_at = header_row.unwrap_or(0);
    let raw_headers = rows.get(header_at).cloned().unwrap_or_default();
    let headers: Vec<String> = raw_headers.iter().map(|cell| normalize(cell)).collect();
    let preset = if header_row.is_some() {
        preset_of(&headers)
    } else {
        "generic"
    };
    let data: Vec<&Vec<String>> = rows.iter().skip(header_at + 1).collect();
    let column = |at: Option<usize>| -> Vec<&str> {
        at.map(|at| {
            data.iter()
                .filter_map(|row| row.get(at).map(String::as_str))
                .filter(|value| !value.is_empty())
                .take(50)
                .collect()
        })
        .unwrap_or_default()
    };
    let date = find(&headers, DATE);
    let mut description: Vec<usize> = DESCRIPTION
        .iter()
        .filter_map(|name| headers.iter().position(|header| header == name))
        .collect();
    description.sort_unstable();
    description.dedup();
    description.truncate(3);
    let debit = find(&headers, DEBIT);
    let credit = find(&headers, CREDIT);
    // Two columns win over one: UBS also has an "individual amount" column
    // that is filled only for the lines of a collective booking.
    let amount = if debit.is_some() || credit.is_some() {
        None
    } else {
        find(&headers, AMOUNT)
    };
    let mut amounts = column(amount);
    amounts.extend(column(debit));
    amounts.extend(column(credit));
    let mapping = CsvMapping {
        delimiter: delimiter.to_string(),
        header_row: header_at,
        date,
        date_order: text::guess_date_order(column(date)),
        description,
        amount,
        debit,
        credit,
        balance: find(&headers, BALANCE),
        currency: find(&headers, CURRENCY),
        reference: find(&headers, REFERENCE),
        counterparty: find(&headers, COUNTERPARTY),
        decimal_comma: text::guess_decimal_comma(amounts),
        default_currency: currency_of(preset, &headers),
    };
    // Raiffeisen repeats the IBAN on every row rather than above the header.
    let mut account = account_in(&rows[..header_at.min(rows.len())]);
    if account.is_empty() {
        if let Some(at) = headers.iter().position(|header| header == "iban") {
            account = column(Some(at))
                .first()
                .map(|value| text::clean(value, 64))
                .unwrap_or_default();
        }
    }
    CsvLayout {
        preset: preset.to_string(),
        account,
        sample: data
            .iter()
            .take(SAMPLE_ROWS)
            .map(|row| (*row).clone())
            .collect(),
        headers: raw_headers,
        mapping,
    }
}

/// Reads every data row with `mapping`. Answers the transactions read and how
/// many rows could not be.
pub fn parse(
    content: &str,
    mapping: &CsvMapping,
    account: &str,
) -> (Vec<ParsedTransaction>, usize) {
    let delimiter = mapping.delimiter.chars().next().unwrap_or(';');
    let rows = records(content, delimiter);
    let mut transactions = Vec::new();
    let mut skipped = 0;
    let get = |row: &Vec<String>, at: Option<usize>| -> String {
        at.and_then(|at| row.get(at)).cloned().unwrap_or_default()
    };
    for row in rows.iter().skip(mapping.header_row + 1) {
        let booked_on = mapping
            .date
            .and_then(|at| row.get(at))
            .and_then(|value| text::parse_date(value, mapping.date_order));
        let amount = match mapping.amount {
            Some(at) => row
                .get(at)
                .and_then(|value| text::parse_amount(value, mapping.decimal_comma)),
            None => {
                let debit = text::parse_amount(&get(row, mapping.debit), mapping.decimal_comma);
                let credit = text::parse_amount(&get(row, mapping.credit), mapping.decimal_comma);
                match (debit, credit) {
                    (None, None) => None,
                    (debit, credit) => Some(credit.unwrap_or(0).abs() - debit.unwrap_or(0).abs()),
                }
            }
        };
        let (Some(booked_on), Some(amount_minor)) = (booked_on, amount) else {
            skipped += 1;
            continue;
        };
        let mut parts: Vec<String> = Vec::new();
        for at in &mapping.description {
            let part = text::clean(&get(row, Some(*at)), MAX_DESCRIPTION);
            if !part.is_empty() && !parts.iter().any(|seen| seen.contains(&part)) {
                parts.push(part);
            }
        }
        let currency = text::clean(&get(row, mapping.currency), 8).to_uppercase();
        transactions.push(ParsedTransaction {
            booked_on,
            amount_minor,
            currency: if currency.is_empty() {
                mapping.default_currency.clone()
            } else {
                currency
            },
            description: text::clean(&parts.join(" "), MAX_DESCRIPTION),
            counterparty: text::clean(&get(row, mapping.counterparty), 200),
            reference: text::clean(&get(row, mapping.reference), 120),
            balance_minor: text::parse_amount(&get(row, mapping.balance), mapping.decimal_comma),
            account: account.to_string(),
        });
    }
    (transactions, skipped)
}
