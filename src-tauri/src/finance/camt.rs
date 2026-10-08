//! ISO 20022 camt.053 (bank to customer statement), the export every Swiss
//! bank offers and many European ones: one `Stmt` per account, its opening
//! and closing balances, and one `Ntry` per booking. A collective booking (a
//! salary run, a batch of card payments) is one entry with several
//! transaction details; it is kept as the one booking the statement shows,
//! so the balances still add up.

use super::text::{self, DateOrder};
use super::{walk_balances, Anchor, ParsedTransaction};
use crate::domain::types::AppError;
use quick_xml::events::Event;
use quick_xml::Reader;

pub struct CamtStatement {
    pub account: String,
    pub currency: String,
    pub transactions: Vec<ParsedTransaction>,
    pub skipped: usize,
}

#[derive(Default)]
struct Entry {
    amount: String,
    currency: String,
    credit: Option<bool>,
    status: String,
    booked: String,
    value: String,
    bank_ref: String,
    detail_ref: String,
    end_to_end: String,
    additional: String,
    creditor: String,
    debtor: String,
    remittance: Vec<String>,
    /// Transaction details under the entry: more than one is a collective
    /// booking, whose first payee does not speak for the whole.
    details: usize,
}

#[derive(Default)]
struct Balance {
    code: String,
    amount: String,
    credit: Option<bool>,
    date: String,
}

fn invalid() -> AppError {
    AppError::new(
        "finance_statement_invalid",
        "This statement could not be read. Check that it is a CSV, OFX or camt.053 export.",
    )
}

/// Whether the text is a camt.053 (or camt.052, read the same way) document.
pub fn looks_like(content: &str) -> bool {
    let head: String = content.chars().take(4000).collect();
    head.contains("camt.053") || head.contains("camt.052") || head.contains("BkToCstmrStmt")
}

fn local(name: &[u8]) -> String {
    let name = String::from_utf8_lossy(name);
    name.rsplit(':').next().unwrap_or_default().to_string()
}

fn entity(reference: &quick_xml::events::BytesRef<'_>) -> String {
    if let Ok(Some(c)) = reference.resolve_char_ref() {
        return c.to_string();
    }
    match reference.decode().as_deref() {
        Ok("amp") => "&".into(),
        Ok("lt") => "<".into(),
        Ok("gt") => ">".into(),
        Ok("quot") => "\"".into(),
        Ok("apos") => "'".into(),
        _ => String::new(),
    }
}

/// The ancestor `depth` levels up from the element that just closed.
fn parent_of(path: &[String], depth: usize) -> &str {
    path.len()
        .checked_sub(depth)
        .and_then(|at| path.get(at))
        .map_or("", String::as_str)
}

struct Stmt {
    account: String,
    currency: String,
    entries: Vec<Entry>,
    balances: Vec<Balance>,
}

pub fn parse(content: &str) -> Result<CamtStatement, AppError> {
    let mut reader = Reader::from_str(content);
    let mut path: Vec<String> = Vec::new();
    let mut text_buffer = String::new();
    let mut statements: Vec<Stmt> = Vec::new();
    let mut entry: Option<Entry> = None;
    let mut balance: Option<Balance> = None;
    let mut detail_count = 0usize;
    let mut amount_currency = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = local(element.name().as_ref());
                text_buffer.clear();
                if name == "Amt" {
                    amount_currency = element
                        .attributes()
                        .flatten()
                        .find(|attribute| local(attribute.key.as_ref()) == "Ccy")
                        .and_then(|attribute| {
                            attribute
                                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .ok()
                        })
                        .map(|value| value.trim().to_uppercase())
                        .unwrap_or_default();
                }
                match name.as_str() {
                    "Stmt" | "Rpt" => statements.push(Stmt {
                        account: String::new(),
                        currency: String::new(),
                        entries: Vec::new(),
                        balances: Vec::new(),
                    }),
                    "Ntry" => {
                        entry = Some(Entry::default());
                        detail_count = 0;
                    }
                    "Bal" => balance = Some(Balance::default()),
                    "TxDtls" => detail_count += 1,
                    _ => {}
                }
                path.push(name);
            }
            Ok(Event::Text(chunk)) => {
                let decoded = chunk
                    .xml_content(quick_xml::XmlVersion::Implicit1_0)
                    .unwrap_or_default();
                text_buffer.push_str(&decoded);
            }
            Ok(Event::GeneralRef(reference)) => text_buffer.push_str(&entity(&reference)),
            Ok(Event::CData(data)) => text_buffer.push_str(&String::from_utf8_lossy(data.as_ref())),
            Ok(Event::End(_)) => {
                let value = text_buffer.trim().to_string();
                text_buffer.clear();
                let Some(name) = path.pop() else { continue };
                let parent = |depth: usize| parent_of(&path, depth).to_string();
                let in_ = |ancestor: &str| path.iter().any(|segment| segment == ancestor);
                if let Some(current) = entry.as_mut() {
                    // Only the first transaction detail speaks for the entry.
                    let first_detail = detail_count <= 1;
                    match name.as_str() {
                        "Amt" if parent(1) == "Ntry" => {
                            current.amount = value.clone();
                            current.currency = amount_currency.clone();
                        }
                        "CdtDbtInd" if parent(1) == "Ntry" => {
                            current.credit = Some(value == "CRDT")
                        }
                        "Cd" | "Sts" if in_("Sts") || name == "Sts" => {
                            if !value.is_empty() {
                                current.status = value.clone();
                            }
                        }
                        "Dt" | "DtTm" if parent(1) == "BookgDt" => current.booked = value.clone(),
                        "Dt" | "DtTm" if parent(1) == "ValDt" => current.value = value.clone(),
                        "AcctSvcrRef" if parent(1) == "Ntry" => current.bank_ref = value.clone(),
                        "AcctSvcrRef" if parent(1) == "Refs" && first_detail => {
                            current.detail_ref = value.clone()
                        }
                        "EndToEndId" if first_detail => current.end_to_end = value.clone(),
                        "AddtlNtryInf" => current.additional = value.clone(),
                        "Nm" if first_detail && in_("Cdtr") && in_("RltdPties") => {
                            current.creditor = value.clone()
                        }
                        "Nm" if first_detail && in_("Dbtr") && in_("RltdPties") => {
                            current.debtor = value.clone()
                        }
                        "Ustrd" if first_detail => current.remittance.push(value.clone()),
                        "AddtlTxInf" if first_detail && current.remittance.is_empty() => {
                            current.remittance.push(value.clone())
                        }
                        _ => {}
                    }
                } else if let Some(current) = balance.as_mut() {
                    match name.as_str() {
                        "Cd" if in_("Tp") => current.code = value.clone(),
                        "Amt" => current.amount = value.clone(),
                        "CdtDbtInd" => current.credit = Some(value == "CRDT"),
                        "Dt" | "DtTm" if parent(1) == "Dt" || name == "DtTm" => {
                            current.date = value.clone()
                        }
                        _ => {}
                    }
                } else if let Some(statement) = statements.last_mut() {
                    match name.as_str() {
                        "IBAN" if in_("Acct") && statement.account.is_empty() => {
                            statement.account = value.clone()
                        }
                        "Id" if in_("Othr")
                            && in_("Acct")
                            && !in_("Svcr")
                            && statement.account.is_empty() =>
                        {
                            statement.account = value.clone()
                        }
                        "Ccy" if parent(1) == "Acct" => statement.currency = value.to_uppercase(),
                        _ => {}
                    }
                }
                match name.as_str() {
                    "Ntry" => {
                        if let (Some(mut done), Some(statement)) =
                            (entry.take(), statements.last_mut())
                        {
                            done.details = detail_count;
                            statement.entries.push(done);
                        }
                    }
                    "Bal" => {
                        if let (Some(done), Some(statement)) =
                            (balance.take(), statements.last_mut())
                        {
                            statement.balances.push(done);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => return Err(invalid()),
            Err(_) => return Err(invalid()),
            _ => {}
        }
    }
    if statements.is_empty() {
        return Err(invalid());
    }
    let mut transactions = Vec::new();
    let mut skipped = 0;
    let account = statements[0].account.clone();
    let currency = statements[0].currency.clone();
    for statement in statements {
        let mut own = Vec::new();
        for entry in statement.entries {
            // A pending booking may still change or vanish: only booked
            // entries are the person's history.
            if matches!(entry.status.as_str(), "PDNG" | "INFO") {
                continue;
            }
            let date = text::parse_date(
                if entry.booked.is_empty() {
                    &entry.value
                } else {
                    &entry.booked
                },
                DateOrder::Ymd,
            );
            let amount = text::parse_amount(&entry.amount, false);
            let (Some(booked_on), Some(amount), Some(credit)) = (date, amount, entry.credit) else {
                skipped += 1;
                continue;
            };
            let collective = entry.details > 1;
            let counterparty = match (collective, credit) {
                (true, _) => "",
                (false, true) => entry.debtor.as_str(),
                (false, false) => entry.creditor.as_str(),
            };
            let remittance = if collective {
                String::new()
            } else {
                entry.remittance.join(" ")
            };
            let mut parts: Vec<&str> = Vec::new();
            for part in [entry.additional.as_str(), counterparty, remittance.as_str()] {
                if !part.is_empty() && !parts.iter().any(|seen| seen.contains(part)) {
                    parts.push(part);
                }
            }
            let reference = [&entry.bank_ref, &entry.detail_ref, &entry.end_to_end]
                .into_iter()
                .find(|reference| !reference.is_empty() && reference.as_str() != "NOTPROVIDED")
                .cloned()
                .unwrap_or_default();
            own.push(ParsedTransaction {
                booked_on,
                amount_minor: if credit { amount.abs() } else { -amount.abs() },
                currency: if entry.currency.is_empty() {
                    statement.currency.clone()
                } else {
                    entry.currency
                },
                description: text::clean(&parts.join(" "), 400),
                counterparty: text::clean(counterparty, 200),
                reference: text::clean(&reference, 120),
                balance_minor: None,
                account: statement.account.clone(),
            });
        }
        let signed = |balance: &Balance| -> Option<(i64, chrono::NaiveDate)> {
            let amount = text::parse_amount(&balance.amount, false)?;
            let on = text::parse_date(&balance.date, DateOrder::Ymd)?;
            Some((
                if balance.credit == Some(false) {
                    -amount.abs()
                } else {
                    amount.abs()
                },
                on,
            ))
        };
        let anchor = statement
            .balances
            .iter()
            .find(|balance| balance.code == "CLBD")
            .and_then(signed)
            .map(|(amount, on)| Anchor::Closing { amount, on })
            .or_else(|| {
                statement
                    .balances
                    .iter()
                    .find(|balance| balance.code == "OPBD" || balance.code == "PRCD")
                    .and_then(signed)
                    .map(|(amount, _)| Anchor::Opening { amount })
            });
        walk_balances(&mut own, anchor);
        transactions.extend(own);
    }
    Ok(CamtStatement {
        account,
        currency,
        transactions,
        skipped,
    })
}
