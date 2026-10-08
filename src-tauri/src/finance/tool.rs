//! `spending_summary` and `transactions_search`, the assistant's read of the
//! person's imported transactions, for agent-lite on the phones and, through
//! the app's local proxy, for the desktop's context MCP. Read only.

use super::store::{self, TransactionQuery, TransactionRow};
use super::summary;
use crate::domain::types::AppError;
use chrono::{Datelike, Duration};
use serde_json::{json, Value};
use sqlx::query::query;
use sqlx_sqlite::SqlitePool;

pub const SPENDING_TOOL: &str = "spending_summary";
pub const SEARCH_TOOL: &str = "transactions_search";
const SEARCH_LIMIT: u32 = 30;

pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": SPENDING_TOOL,
                "description": "Summarise the user's spending and income from the bank statements they imported into Sub Rosa: totals, spending by category and by month, the merchants the money goes to, and the balance trend. Amounts are in the account currency, money out positive in spending. Transfers between the user's own accounts and savings are left out of spending. Use it for questions like how much they spent on something, where their money goes, or how a month compares.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from": { "type": "string", "description": "First day, YYYY-MM-DD. Defaults to the first day of the month three months ago." },
                        "to": { "type": "string", "description": "Last day, YYYY-MM-DD. Defaults to today." },
                        "category": { "type": "string", "description": "Only this category (for example groceries, dining, transport, housing, subscriptions)." },
                        "currency": { "type": "string", "description": "A currency code, when the user has accounts in several." }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": SEARCH_TOOL,
                "description": "Find individual transactions in the bank statements the user imported into Sub Rosa, newest first: by words in the description or the payee, a category, a period, or an amount range. Amounts are signed, negative for money out.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Words to look for, such as a merchant name." },
                        "category": { "type": "string", "description": "A category, or an empty string for the ones not filed yet." },
                        "from": { "type": "string", "description": "First day, YYYY-MM-DD." },
                        "to": { "type": "string", "description": "Last day, YYYY-MM-DD." },
                        "min_amount": { "type": "number", "description": "Lowest signed amount, in currency units." },
                        "max_amount": { "type": "number", "description": "Highest signed amount, in currency units." },
                        "limit": { "type": "integer", "description": "How many, 1 to 30. Defaults to 15." }
                    }
                }
            }
        }),
    ]
}

/// Whether there is anything for the tools to read.
pub async fn available(pool: &SqlitePool) -> bool {
    query("SELECT 1 FROM transactions LIMIT 1")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .is_some()
}

fn units(minor: i64) -> f64 {
    minor as f64 / 100.0
}

fn day_arg(args: &Value, key: &str) -> Result<Option<chrono::NaiveDate>, AppError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(super::parse_day)
        .transpose()
}

pub async fn spending(pool: &SqlitePool, args: &Value) -> Result<Value, AppError> {
    let today = chrono::Local::now().date_naive();
    let default_from = (today - Duration::days(92)).with_day(1).unwrap_or(today);
    let from = day_arg(args, "from")?.unwrap_or(default_from);
    let to = day_arg(args, "to")?.unwrap_or(today);
    let mut rows = store::rows_between(pool, from, to).await?;
    if let Some(category) = args.get("category").and_then(Value::as_str).map(str::trim) {
        rows.retain(|row| row.category == category);
    }
    let currency = args
        .get("currency")
        .and_then(Value::as_str)
        .map(str::to_uppercase);
    let overview = summary::overview(&rows, currency.as_deref());
    let label = |category: &str| {
        if category.is_empty() {
            "uncategorized".to_string()
        } else {
            category.to_string()
        }
    };
    Ok(json!({
        "from": from.to_string(),
        "to": to.to_string(),
        "currency": overview.currency,
        "otherCurrencies": overview.currencies.iter().filter(|c| **c != overview.currency).collect::<Vec<_>>(),
        "transactions": overview.transactions,
        "spending": units(overview.spending_minor),
        "income": units(overview.income_minor),
        "byCategory": overview.categories.iter().map(|c| json!({ "category": label(&c.category), "spent": units(c.amount_minor) })).collect::<Vec<_>>(),
        "byMonth": overview.months.iter().map(|m| json!({
            "month": m.month,
            "spent": units(m.spending_minor),
            "income": units(m.income_minor),
            "topCategories": m.by_category.iter().take(5).map(|c| json!({ "category": label(&c.category), "spent": units(c.amount_minor) })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "topMerchants": overview.merchants.iter().map(|m| json!({ "name": m.name, "spent": units(m.amount_minor), "count": m.count })).collect::<Vec<_>>(),
        "balance": overview.balance.last().map(|point| json!({
            "day": point.day,
            "amount": units(point.balance_minor),
            "stated": overview.balance_known,
        })),
    }))
}

fn minor_arg(args: &Value, key: &str) -> Option<i64> {
    args.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| (value * 100.0).round() as i64)
}

pub async fn search(pool: &SqlitePool, args: &Value) -> Result<Value, AppError> {
    let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);
    let filter = TransactionQuery {
        search: text("query"),
        category: text("category"),
        from: text("from").filter(|day| !day.trim().is_empty()),
        to: text("to").filter(|day| !day.trim().is_empty()),
        min_amount: minor_arg(args, "min_amount"),
        max_amount: minor_arg(args, "max_amount"),
        suggested: None,
        limit: Some(
            args.get("limit")
                .and_then(Value::as_u64)
                .map_or(15, |limit| limit.clamp(1, u64::from(SEARCH_LIMIT)) as u32),
        ),
        offset: None,
    };
    let rows: Vec<TransactionRow> = store::search(pool, &filter).await?;
    Ok(json!({
        "count": rows.len(),
        "transactions": rows.iter().map(|row| json!({
            "date": row.booked_on,
            "amount": units(row.amount_minor),
            "currency": row.currency,
            "description": row.description,
            "payee": row.counterparty,
            "category": if row.category.is_empty() { "uncategorized" } else { row.category.as_str() },
            "account": row.account,
        })).collect::<Vec<_>>(),
    }))
}

/// Agent-lite: runs whichever of the two tools was called.
pub async fn run(pool: &SqlitePool, name: &str, args: &Value) -> String {
    let answer = if name == SPENDING_TOOL {
        spending(pool, args).await
    } else {
        search(pool, args).await
    };
    match answer {
        Ok(value) => value.to_string(),
        Err(error) => json!({ "error": error.message }).to_string(),
    }
}
