//! Finances (ADR-0099): bank statements the person exports from their bank
//! and imports here, read into one local table of transactions, categorised
//! by rules and by suggestions the person confirms, and summarised for them
//! and for the assistant.
//!
//! No bank is contacted and no aggregator sees an account: the statement is
//! a file the person chose, read on this device. Three formats arrive the
//! same way (the file picker, then this module): CSV with a column mapping
//! the person checks ([`csv`]), OFX or QFX ([`ofx`]), and ISO 20022
//! camt.053 ([`camt`]). Reading a statement twice, or two that overlap, adds
//! only what is new (`dedup_key`). Nothing leaves the device unless the
//! person switches finance sync on, and model suggestions send descriptions
//! only, never amounts or accounts, and only when asked for.
//!
//! The budget engine on the home server is a separate program with its own
//! ledger. The bridge to it is manual: rules travel both ways in its
//! `rules.json` shape and transactions leave as a CSV in its column names
//! ([`bridge`]). The app never calls it.

pub mod bridge;
pub mod camt;
pub mod csv;
pub mod ofx;
pub mod rules;
mod store;
pub mod suggest;
pub mod summary;
pub mod text;
pub mod tool;

use crate::domain::types::AppError;
use base64::Engine;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

pub use store::{TransactionQuery, TransactionRow};

/// A statement larger than this is not one month of one account.
const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
const PREVIEW_ROWS: usize = 5;

/// The categories the app names in every language. A person may use any
/// other word; it is kept and shown as written.
pub const CATEGORIES: &[&str] = &[
    "groceries",
    "dining",
    "transport",
    "housing",
    "utilities",
    "health",
    "insurance",
    "shopping",
    "leisure",
    "travel",
    "subscriptions",
    "education",
    "taxes",
    "fees",
    "cash",
    "income",
    "savings",
    "transfers",
    "other",
];

/// Money moved between the person's own accounts is neither spent nor
/// earned.
pub const NOT_SPENDING: &[&str] = &["transfers", "savings"];

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTransaction {
    pub booked_on: NaiveDate,
    pub amount_minor: i64,
    pub currency: String,
    pub description: String,
    pub counterparty: String,
    /// The bank's own reference for the booking, when the format has one.
    pub reference: String,
    pub balance_minor: Option<i64>,
    pub account: String,
}

/// A balance a statement states, from which the running balance after each
/// booking follows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Anchor {
    Closing { amount: i64, on: NaiveDate },
    Opening { amount: i64 },
}

/// Fills `balance_minor` from a stated balance, in booking order. A closing
/// balance is walked back from the last booking, and only when no booking
/// is dated after it. A balance a row already carries is kept.
pub fn walk_balances(transactions: &mut [ParsedTransaction], anchor: Option<Anchor>) {
    let mut order: Vec<usize> = (0..transactions.len()).collect();
    order.sort_by_key(|at| transactions[*at].booked_on);
    match anchor {
        Some(Anchor::Closing { amount, on }) => {
            if transactions.iter().any(|tx| tx.booked_on > on) {
                return;
            }
            let mut balance = amount;
            for at in order.into_iter().rev() {
                let tx = &mut transactions[at];
                tx.balance_minor.get_or_insert(balance);
                balance -= tx.amount_minor;
            }
        }
        Some(Anchor::Opening { amount }) => {
            let mut balance = amount;
            for at in order {
                let tx = &mut transactions[at];
                balance += tx.amount_minor;
                tx.balance_minor.get_or_insert(balance);
            }
        }
        None => {}
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Csv,
    Ofx,
    Camt053,
}

impl Format {
    pub fn key(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Ofx => "ofx",
            Format::Camt053 => "camt053",
        }
    }
}

/// A statement read with the mapping it will be imported with.
#[derive(Debug)]
pub struct ReadStatement {
    pub format: Format,
    pub preset: String,
    pub account: String,
    pub transactions: Vec<ParsedTransaction>,
    pub skipped: usize,
    pub layout: Option<csv::CsvLayout>,
}

fn too_large() -> AppError {
    AppError::new(
        "finance_statement_too_large",
        "This statement is too large to import. Export a shorter period.",
    )
}

pub(crate) fn invalid_statement() -> AppError {
    AppError::new(
        "finance_statement_invalid",
        "This statement could not be read. Check that it is a CSV, OFX or camt.053 export.",
    )
}

/// Reads a statement's bytes. A CSV is read with `mapping` when the person
/// confirmed one, otherwise with the detected one. `account` overrides what
/// the file says.
pub fn read(
    bytes: &[u8],
    mapping: Option<&csv::CsvMapping>,
    account: Option<&str>,
) -> Result<ReadStatement, AppError> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(too_large());
    }
    let content = text::decode(bytes);
    let chosen = account.map(str::trim).filter(|account| !account.is_empty());
    let mut read = if camt::looks_like(&content) {
        let statement = camt::parse(&content)?;
        ReadStatement {
            format: Format::Camt053,
            preset: String::new(),
            account: statement.account,
            transactions: statement.transactions,
            skipped: statement.skipped,
            layout: None,
        }
    } else if ofx::looks_like(&content) {
        let statement = ofx::parse(&content)?;
        ReadStatement {
            format: Format::Ofx,
            preset: String::new(),
            account: statement.account,
            transactions: statement.transactions,
            skipped: statement.skipped,
            layout: None,
        }
    } else {
        let layout = csv::detect(&content);
        let mapping = mapping.cloned().unwrap_or_else(|| layout.mapping.clone());
        let account = chosen
            .map(str::to_string)
            .unwrap_or_else(|| layout.account.clone());
        let (transactions, skipped) = csv::parse(&content, &mapping, &account);
        ReadStatement {
            format: Format::Csv,
            preset: layout.preset.clone(),
            account,
            transactions,
            skipped,
            layout: Some(csv::CsvLayout { mapping, ..layout }),
        }
    };
    if let Some(account) = chosen {
        let account = text::clean(account, 64);
        for tx in &mut read.transactions {
            tx.account = account.clone();
        }
        read.account = account;
    }
    Ok(read)
}

// --- Commands ----------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementRequest {
    pub file_name: String,
    /// The file's bytes, base64.
    pub data: String,
    #[serde(default)]
    pub mapping: Option<csv::CsvMapping>,
    #[serde(default)]
    pub account: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTransaction {
    pub booked_on: String,
    pub amount_minor: i64,
    pub currency: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementPreview {
    pub format: Format,
    pub preset: String,
    pub account: String,
    pub count: usize,
    /// How many of them this device does not have yet.
    pub new_count: usize,
    pub skipped: usize,
    pub first_day: Option<String>,
    pub last_day: Option<String>,
    pub sample: Vec<PreviewTransaction>,
    /// The exact same file was imported before.
    pub already_imported: bool,
    pub csv: Option<csv::CsvLayout>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub statement_id: String,
    pub added: usize,
    pub skipped: usize,
    pub categorized: usize,
}

fn bytes_of(request: &StatementRequest) -> Result<Vec<u8>, AppError> {
    if request.data.len() > MAX_FILE_BYTES * 4 / 3 + 4 {
        return Err(too_large());
    }
    base64::engine::general_purpose::STANDARD
        .decode(request.data.trim())
        .map_err(|_| invalid_statement())
}

pub async fn preview(
    pool: &SqlitePool,
    request: &StatementRequest,
) -> Result<StatementPreview, AppError> {
    let bytes = bytes_of(request)?;
    let read = read(&bytes, request.mapping.as_ref(), request.account.as_deref())?;
    let keys = store::dedup_keys(&read.transactions);
    let new_count = store::unknown_keys(pool, &keys).await?;
    let first_day = read.transactions.iter().map(|tx| tx.booked_on).min();
    let last_day = read.transactions.iter().map(|tx| tx.booked_on).max();
    Ok(StatementPreview {
        format: read.format,
        preset: read.preset,
        account: read.account,
        count: read.transactions.len(),
        new_count,
        skipped: read.skipped,
        first_day: first_day.map(|day| day.to_string()),
        last_day: last_day.map(|day| day.to_string()),
        sample: read
            .transactions
            .iter()
            .take(PREVIEW_ROWS)
            .map(|tx| PreviewTransaction {
                booked_on: tx.booked_on.to_string(),
                amount_minor: tx.amount_minor,
                currency: tx.currency.clone(),
                description: tx.description.clone(),
            })
            .collect(),
        already_imported: store::statement_known(pool, &store::digest(&bytes)).await?,
        csv: read.layout,
    })
}

pub async fn import(
    pool: &SqlitePool,
    request: &StatementRequest,
) -> Result<ImportResult, AppError> {
    let bytes = bytes_of(request)?;
    let read = read(&bytes, request.mapping.as_ref(), request.account.as_deref())?;
    if read.transactions.is_empty() {
        return Err(AppError::new(
            "finance_statement_empty",
            "No transaction could be read from this statement. Check the columns.",
        ));
    }
    let file_name = text::clean(&request.file_name, 200);
    store::import(pool, &file_name, &read, &store::digest(&bytes)).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceStatus {
    pub sync: bool,
    pub transactions: i64,
    pub uncategorized: i64,
    pub suggestions: i64,
    pub statements: Vec<store::StatementRow>,
}

#[tauri::command]
pub async fn finance_status(app: AppHandle) -> Result<FinanceStatus, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    store::status(&repos.pool).await
}

#[tauri::command]
pub async fn finance_set_sync(app: AppHandle, sync: bool) -> Result<FinanceStatus, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    store::set_sync(&repos.pool, sync).await?;
    if sync {
        for table in ["finance_rules", "transactions"] {
            crate::account::sync::enqueue_existing(&repos.pool, table, "1=1").await?;
        }
    }
    store::status(&repos.pool).await
}

#[tauri::command]
pub async fn finance_preview(
    app: AppHandle,
    request: StatementRequest,
) -> Result<StatementPreview, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    preview(&repos.pool, &request).await
}

#[tauri::command]
pub async fn finance_import(
    app: AppHandle,
    request: StatementRequest,
) -> Result<ImportResult, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    import(&repos.pool, &request).await
}

#[tauri::command]
pub async fn finance_transactions(
    app: AppHandle,
    query: TransactionQuery,
) -> Result<Vec<TransactionRow>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    store::search(&repos.pool, &query).await
}

/// The person's category for one transaction. With `remember`, a rule on its
/// counterparty (or description) files the others like it too.
#[tauri::command]
pub async fn finance_set_category(
    app: AppHandle,
    id: String,
    category: String,
    remember: bool,
) -> Result<usize, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    store::set_category(&repos.pool, &id, &category, remember).await
}

#[tauri::command]
pub async fn finance_overview(
    app: AppHandle,
    from: String,
    to: String,
) -> Result<summary::Overview, AppError> {
    let (from, to) = (parse_day(&from)?, parse_day(&to)?);
    let repos = crate::commands::repositories(&app).await?;
    let rows = store::rows_between(&repos.pool, from, to).await?;
    Ok(summary::overview(&rows, None))
}

#[tauri::command]
pub async fn finance_rules(app: AppHandle) -> Result<Vec<rules::Rule>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    store::rules(&repos.pool).await
}

#[tauri::command]
pub async fn finance_rule_add(
    app: AppHandle,
    pattern: String,
    category: String,
    is_regex: bool,
) -> Result<usize, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    store::add_rule(&repos.pool, &pattern, &category, is_regex).await
}

#[tauri::command]
pub async fn finance_rule_remove(app: AppHandle, id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    store::remove_rule(&repos.pool, &id).await
}

/// Asks the model to propose a category for what no rule filed. Nothing is
/// filed until the person confirms.
#[tauri::command]
pub async fn finance_suggest(app: AppHandle) -> Result<usize, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    suggest::suggest(&repos.pool).await
}

#[tauri::command]
pub async fn finance_resolve_suggestions(
    app: AppHandle,
    ids: Vec<String>,
    accept: bool,
) -> Result<usize, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    store::resolve_suggestions(&repos.pool, &ids, accept).await
}

/// Deletes one statement's transactions, or every transaction, statement
/// and rule on this device.
#[tauri::command]
pub async fn finance_forget(
    app: AppHandle,
    statement_id: Option<String>,
) -> Result<FinanceStatus, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    store::forget(&repos.pool, statement_id.as_deref()).await?;
    store::status(&repos.pool).await
}

/// The budget engine bridge, outward: `transactions` as a CSV in the
/// engine's column names, or `rules` in its `rules.json` shape. Delivered
/// like any export (save dialog, share sheet).
#[tauri::command]
pub async fn finance_export(
    app: AppHandle,
    kind: String,
) -> Result<crate::conversation_export::ExportConversationResult, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let (name, filter, bytes) = match kind.as_str() {
        "rules" => (
            "rules.json",
            ("JSON", "json"),
            bridge::rules_json(&store::rules(&repos.pool).await?).into_bytes(),
        ),
        _ => (
            "transactions.csv",
            ("CSV", "csv"),
            bridge::transactions_csv(
                &store::rows_between(&repos.pool, store::EARLIEST, store::LATEST).await?,
            )
            .into_bytes(),
        ),
    };
    crate::conversation_export::deliver(&app, name, filter, bytes).await
}

/// The budget engine bridge, inward: its `rules.json`, pasted or picked.
#[tauri::command]
pub async fn finance_import_rules(app: AppHandle, data: String) -> Result<usize, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let imported = bridge::parse_rules_json(&data)?;
    store::import_rules(&repos.pool, &imported).await
}

pub(crate) fn parse_day(text: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::new("finance_day_invalid", "This date is not valid."))
}

#[cfg(test)]
mod tests;
