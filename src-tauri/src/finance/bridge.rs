//! The manual bridge to the household budget engine (its README:
//! `budget-engine/README.md`). The engine keeps its own ledger, reads only
//! its banks' PDF statements, and files with an ordered list of regular
//! expressions in `config/rules.json`: `{"user": [...], "rules": [...]}`,
//! each `{pattern, type, cat, sub}`, the first match winning, `user` before
//! `rules`, types `revenu`, `depense`, `epargne`, `interne`, `financement`.
//!
//! So the bridge is two files the person carries by hand, never a call:
//! that `rules.json` read in here (and this app's rules written out in its
//! shape, to merge into the engine's `user` list), and the transactions
//! written as a CSV in the column names of the engine's `v_tx` view.

use super::rules::Rule;
use super::store::TransactionRow;
use crate::domain::types::AppError;
use serde_json::{json, Value};

fn invalid() -> AppError {
    AppError::new(
        "finance_rules_invalid",
        "These rules could not be read. Choose the budget engine's rules.json file.",
    )
}

/// The engine's type for one of this app's categories.
fn engine_type(category: &str, amount_minor: i64) -> &'static str {
    match category {
        "transfers" => "interne",
        "savings" => "epargne",
        "income" => "revenu",
        _ if amount_minor > 0 => "revenu",
        _ => "depense",
    }
}

/// Rules from the engine's `rules.json`: `(pattern, is_regex, category)`,
/// `user` first. An internal transfer, a saving or an income keeps the
/// meaning this app's summaries depend on; any other line keeps the engine's
/// own category name.
pub fn parse_rules_json(data: &str) -> Result<Vec<(String, bool, String)>, AppError> {
    let value: Value =
        serde_json::from_str(data.trim_start_matches('\u{feff}')).map_err(|_| invalid())?;
    let lists = ["user", "rules"]
        .iter()
        .filter_map(|key| value.get(*key).and_then(Value::as_array))
        .flatten();
    let mut rules = Vec::new();
    for entry in lists {
        let (Some(pattern), Some(category)) = (
            entry.get("pattern").and_then(Value::as_str),
            entry.get("cat").and_then(Value::as_str),
        ) else {
            continue;
        };
        let category = match entry.get("type").and_then(Value::as_str) {
            Some("interne") => "transfers",
            Some("epargne") => "savings",
            Some("revenu") => "income",
            _ => category,
        };
        if !pattern.trim().is_empty() && !category.trim().is_empty() {
            rules.push((pattern.to_string(), true, category.to_string()));
        }
    }
    if rules.is_empty() {
        return Err(invalid());
    }
    Ok(rules)
}

/// Escapes plain text for the engine's Python regular expressions.
fn python_escape(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if "\\.^$*+?{}[]|()".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// This app's rules in the engine's shape, as a `user` list to merge by hand.
pub fn rules_json(rules: &[Rule]) -> String {
    let user: Vec<Value> = rules
        .iter()
        .map(|rule| {
            json!({
                "pattern": if rule.is_regex { rule.pattern.clone() } else { python_escape(&rule.pattern) },
                "type": engine_type(&rule.category, -1),
                "cat": rule.category,
                "sub": ""
            })
        })
        .collect();
    let document = json!({
        "_doc": "Exported from Sub Rosa. Merge the user list into config/rules.json by hand, keeping your own lines.",
        "user": user,
        "rules": []
    });
    serde_json::to_string_pretty(&document).unwrap_or_default()
}

fn csv_cell(text: &str) -> String {
    if text.contains([';', '"', '\n', '\r']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_string()
    }
}

/// Transactions with the engine's `v_tx` columns, semicolon separated with a
/// decimal point, as its own exports are.
pub fn transactions_csv(rows: &[TransactionRow]) -> String {
    let mut out =
        String::from("date;month;account;holder;label;detail;amount;currency;type;cat;sub\n");
    for row in rows {
        let amount = format!(
            "{}{}.{:02}",
            if row.amount_minor < 0 { "-" } else { "" },
            row.amount_minor.abs() / 100,
            row.amount_minor.abs() % 100
        );
        let cells = [
            row.booked_on.clone(),
            row.booked_on.chars().take(7).collect(),
            row.account.clone(),
            String::new(),
            row.description.clone(),
            row.counterparty.clone(),
            amount,
            row.currency.clone(),
            engine_type(&row.category, row.amount_minor).to_string(),
            row.category.clone(),
            String::new(),
        ];
        out.push_str(
            &cells
                .iter()
                .map(|cell| csv_cell(cell))
                .collect::<Vec<_>>()
                .join(";"),
        );
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engines_rules_are_read_user_first() {
        let data = include_str!("fixtures/budget-engine-rules.json");
        let rules = parse_rules_json(data).unwrap();
        assert_eq!(
            rules[0],
            (
                "Carte \"Claude\"".to_string(),
                true,
                "transfers".to_string()
            )
        );
        assert!(rules
            .iter()
            .any(|(pattern, _, category)| pattern.starts_with("Migros|Coop")
                && category == "Courses"));
        assert!(rules.iter().all(|(_, is_regex, _)| *is_regex));
        assert!(parse_rules_json("{\"user\": []}").is_err());
        assert!(parse_rules_json("not json").is_err());
    }

    #[test]
    fn rules_leave_in_the_engines_shape() {
        let rules = vec![Rule {
            id: "1".into(),
            pattern: "Boulangerie (Paul)".into(),
            is_regex: false,
            category: "dining".into(),
            position: 0,
        }];
        let json: Value = serde_json::from_str(&rules_json(&rules)).unwrap();
        assert_eq!(json["user"][0]["pattern"], "Boulangerie \\(Paul\\)");
        assert_eq!(json["user"][0]["type"], "depense");
        assert_eq!(json["rules"], json!([]));
    }

    #[test]
    fn transactions_leave_with_the_v_tx_columns() {
        let row = TransactionRow {
            id: "1".into(),
            account: "CH93".into(),
            booked_on: "2026-09-02".into(),
            amount_minor: -8_405,
            currency: "CHF".into(),
            description: "Migros; M Lausanne".into(),
            counterparty: String::new(),
            category: "groceries".into(),
            category_source: "rule".into(),
            suggestion: String::new(),
            balance_minor: None,
        };
        let csv = transactions_csv(&[row]);
        let mut lines = csv.lines();
        assert_eq!(
            lines.next().unwrap(),
            "date;month;account;holder;label;detail;amount;currency;type;cat;sub"
        );
        assert_eq!(
            lines.next().unwrap(),
            "2026-09-02;2026-09;CH93;;\"Migros; M Lausanne\";;-84.05;CHF;depense;groceries;"
        );
    }
}
