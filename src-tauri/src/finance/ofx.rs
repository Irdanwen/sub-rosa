//! OFX and QFX statements (the French banks' "Money" export, and most
//! American ones): SGML in version 1, where a value's closing tag is
//! optional, and XML in version 2. Both are read by one scanner that
//! treats `<TAG>value` as a value and `<TAG>`...`</TAG>` as a block.

use super::text::{self, DateOrder};
use super::{walk_balances, Anchor, ParsedTransaction};
use crate::domain::types::AppError;

#[derive(Default)]
struct Pending {
    posted: String,
    amount: String,
    fitid: String,
    name: String,
    memo: String,
    payee: String,
}

pub struct OfxStatement {
    pub account: String,
    pub currency: String,
    pub transactions: Vec<ParsedTransaction>,
    pub skipped: usize,
}

fn invalid() -> AppError {
    AppError::new(
        "finance_statement_invalid",
        "This statement could not be read. Check that it is a CSV, OFX or camt.053 export.",
    )
}

/// Whether the text looks like an OFX statement.
pub fn looks_like(content: &str) -> bool {
    let head: String = content
        .chars()
        .take(4000)
        .collect::<String>()
        .to_uppercase();
    head.contains("OFXHEADER") || head.contains("<OFX>")
}

pub fn parse(content: &str) -> Result<OfxStatement, AppError> {
    let upper = content.to_uppercase();
    let start = upper.find("<OFX>").ok_or_else(invalid)?;
    let body = &content[start..];
    let mut account = String::new();
    let mut currency = String::new();
    let mut in_ledger = false;
    let mut in_payee = false;
    let mut ledger_amount = String::new();
    let mut ledger_date = String::new();
    let mut current: Option<Pending> = None;
    let mut pending: Vec<Pending> = Vec::new();
    let mut rest = body;
    while let Some(open) = rest.find('<') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('>') else { break };
        let tag = after[..close].trim().to_uppercase();
        let tail = &after[close + 1..];
        let value_end = tail.find('<').unwrap_or(tail.len());
        let value = tail[..value_end].trim();
        // Entities in OFX values are the five XML ones.
        let value = value
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&");
        rest = tail;
        match tag.as_str() {
            "STMTTRN" => current = Some(Pending::default()),
            "/STMTTRN" => {
                if let Some(done) = current.take() {
                    pending.push(done);
                }
            }
            "LEDGERBAL" => in_ledger = true,
            "/LEDGERBAL" => in_ledger = false,
            "PAYEE" => in_payee = true,
            "/PAYEE" => in_payee = false,
            "CURDEF" if currency.is_empty() => currency = value.to_uppercase(),
            "ACCTID" if account.is_empty() => account = text::clean(&value, 64),
            "BALAMT" if in_ledger => ledger_amount = value,
            "DTASOF" if in_ledger => ledger_date = value,
            _ => {
                if let Some(entry) = current.as_mut() {
                    match tag.as_str() {
                        "DTPOSTED" => entry.posted = value,
                        "TRNAMT" => entry.amount = value,
                        "FITID" => entry.fitid = value,
                        "NAME" if in_payee => entry.payee = value,
                        "NAME" => entry.name = value,
                        "MEMO" => entry.memo = value,
                        _ => {}
                    }
                }
            }
        }
    }
    // An SGML file may leave the last transaction open before </BANKTRANLIST>.
    if let Some(done) = current.take() {
        pending.push(done);
    }
    let mut skipped = 0;
    let mut transactions = Vec::new();
    for entry in pending {
        let date = text::parse_date(&entry.posted, DateOrder::Ymd);
        let amount = text::parse_amount(&entry.amount, false);
        let (Some(booked_on), Some(amount_minor)) = (date, amount) else {
            skipped += 1;
            continue;
        };
        let name = if entry.name.is_empty() {
            entry.payee.clone()
        } else {
            entry.name.clone()
        };
        let description = if entry.memo.is_empty() || name.contains(&entry.memo) {
            name.clone()
        } else if entry.memo.contains(&name) {
            entry.memo.clone()
        } else {
            format!("{name} {}", entry.memo)
        };
        transactions.push(ParsedTransaction {
            booked_on,
            amount_minor,
            currency: currency.clone(),
            description: text::clean(&description, 400),
            counterparty: text::clean(&name, 200),
            reference: text::clean(&entry.fitid, 120),
            balance_minor: None,
            account: account.clone(),
        });
    }
    if transactions.is_empty() && skipped == 0 && !upper.contains("STMTTRN") {
        return Err(invalid());
    }
    let closing = text::parse_amount(&ledger_amount, false)
        .zip(text::parse_date(&ledger_date, DateOrder::Ymd))
        .map(|(amount, on)| Anchor::Closing { amount, on });
    walk_balances(&mut transactions, closing);
    Ok(OfxStatement {
        account,
        currency,
        transactions,
        skipped,
    })
}
