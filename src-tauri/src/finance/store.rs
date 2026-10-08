//! The finance tables: statements read, transactions, rules, and this
//! device's sync choice.

use super::rules::{self, Categorizer, Rule};
use super::text::normalize;
use super::{ImportResult, ParsedTransaction, ReadStatement};
use crate::domain::types::AppError;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::{SqlitePool, SqliteRow};

pub const EARLIEST: NaiveDate = match NaiveDate::from_ymd_opt(1, 1, 1) {
    Some(day) => day,
    None => NaiveDate::MIN,
};
pub const LATEST: NaiveDate = match NaiveDate::from_ymd_opt(9999, 12, 31) {
    Some(day) => day,
    None => NaiveDate::MAX,
};
const MAX_CATEGORY_CHARS: usize = 60;
const MAX_PATTERN_CHARS: usize = 300;
const SEARCH_LIMIT: u32 = 200;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn digest(bytes: &[u8]) -> String {
    hex(&sha2::Sha256::digest(bytes))
}

/// The key a transaction is recognised by when it is read again. The bank's
/// reference when there is one (with the day and amount, because some banks
/// reuse a payment reference every month); otherwise a digest of what the
/// statement says, numbered by its occurrence in the file, so two identical
/// coffees on one day stay two transactions and reading the file again
/// still finds both.
pub fn dedup_keys(transactions: &[ParsedTransaction]) -> Vec<String> {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    transactions
        .iter()
        .map(|tx| {
            let account: String = normalize(&tx.account)
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            if !tx.reference.is_empty() {
                return format!(
                    "ref:{account}:{}:{}:{}",
                    tx.reference, tx.booked_on, tx.amount_minor
                );
            }
            let basis = format!(
                "{account}|{}|{}|{}|{}",
                tx.booked_on,
                tx.amount_minor,
                tx.currency,
                normalize(&tx.description)
            );
            let occurrence = seen.entry(basis.clone()).or_insert(0);
            *occurrence += 1;
            format!(
                "h:{}",
                &hex(&sha2::Sha256::digest(
                    format!("{basis}|{occurrence}").as_bytes()
                ))[..32]
            )
        })
        .collect()
}

/// The id a transaction travels under, from its key: two devices importing
/// one statement make one object.
pub fn transaction_id(key: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("subrosa:transaction:{key}").as_bytes(),
    )
    .hyphenated()
    .to_string()
}

pub(super) async fn unknown_keys(pool: &SqlitePool, keys: &[String]) -> Result<usize, AppError> {
    let mut known = 0usize;
    for chunk in keys.chunks(400) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT count(*) AS n FROM transactions WHERE dedup_key IN ({marks})");
        let mut statement = query(&sql);
        for key in chunk {
            statement = statement.bind(key);
        }
        known += statement.fetch_one(pool).await?.get::<i64, _>("n") as usize;
    }
    let distinct: std::collections::HashSet<&String> = keys.iter().collect();
    Ok(distinct.len().saturating_sub(known))
}

pub(super) async fn statement_known(pool: &SqlitePool, digest: &str) -> Result<bool, AppError> {
    Ok(query("SELECT 1 FROM bank_statements WHERE digest = ?1")
        .bind(digest)
        .fetch_optional(pool)
        .await?
        .is_some())
}

pub(super) async fn import(
    pool: &SqlitePool,
    file_name: &str,
    read: &ReadStatement,
    digest: &str,
) -> Result<ImportResult, AppError> {
    let categorizer = Categorizer::new(&rules(pool).await?);
    let keys = dedup_keys(&read.transactions);
    let statement_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    let (mut added, mut categorized) = (0usize, 0usize);
    for (parsed, key) in read.transactions.iter().zip(&keys) {
        let category = categorizer.categorize(&parsed.description, &parsed.counterparty);
        let result = query(
            "INSERT INTO transactions (id, dedup_key, account, booked_on, amount_minor, currency,
               description, counterparty, reference, balance_minor, category, category_source,
               statement_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
             ON CONFLICT(dedup_key) DO NOTHING",
        )
        .bind(transaction_id(key))
        .bind(key)
        .bind(&parsed.account)
        .bind(parsed.booked_on.to_string())
        .bind(parsed.amount_minor)
        .bind(&parsed.currency)
        .bind(&parsed.description)
        .bind(&parsed.counterparty)
        .bind(&parsed.reference)
        .bind(parsed.balance_minor)
        .bind(category.clone().unwrap_or_default())
        .bind(if category.is_some() { "rule" } else { "" })
        .bind(&statement_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() > 0 {
            added += 1;
            categorized += usize::from(category.is_some());
        }
    }
    let skipped = read.skipped + read.transactions.len() - added;
    query(
        "INSERT INTO bank_statements (id, file_name, format, preset, account, digest, added, skipped, imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(&statement_id)
    .bind(file_name)
    .bind(read.format.key())
    .bind(&read.preset)
    .bind(&read.account)
    .bind(digest)
    .bind(added as i64)
    .bind(skipped as i64)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(ImportResult {
        statement_id,
        added,
        skipped,
        categorized,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementRow {
    pub id: String,
    pub file_name: String,
    pub format: String,
    pub preset: String,
    pub account: String,
    pub added: i64,
    pub skipped: i64,
    pub imported_at: String,
}

pub(super) async fn status(pool: &SqlitePool) -> Result<super::FinanceStatus, AppError> {
    let sync: i64 = query("SELECT sync FROM finance_settings WHERE id = 1")
        .fetch_optional(pool)
        .await?
        .map_or(0, |row| row.get("sync"));
    let counts = query(
        "SELECT count(*) AS total,
           coalesce(sum(CASE WHEN category = '' THEN 1 ELSE 0 END), 0) AS open,
           coalesce(sum(CASE WHEN suggestion <> '' AND category_source <> 'person' THEN 1 ELSE 0 END), 0) AS suggested
         FROM transactions",
    )
    .fetch_one(pool)
    .await?;
    let statements = query(
        "SELECT id, file_name, format, preset, account, added, skipped, imported_at
         FROM bank_statements ORDER BY imported_at DESC LIMIT 50",
    )
    .fetch_all(pool)
    .await?
    .iter()
    .map(|row| StatementRow {
        id: row.get("id"),
        file_name: row.get("file_name"),
        format: row.get("format"),
        preset: row.get("preset"),
        account: row.get("account"),
        added: row.get("added"),
        skipped: row.get("skipped"),
        imported_at: row.get("imported_at"),
    })
    .collect();
    Ok(super::FinanceStatus {
        sync: sync != 0,
        transactions: counts.get("total"),
        uncategorized: counts.get("open"),
        suggestions: counts.get("suggested"),
        statements,
    })
}

pub(super) async fn set_sync(pool: &SqlitePool, sync: bool) -> Result<(), AppError> {
    query("UPDATE finance_settings SET sync = ?1, updated_at = ?2 WHERE id = 1")
        .bind(i64::from(sync))
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionQuery {
    /// Words looked for in the description and the counterparty.
    #[serde(default)]
    pub search: Option<String>,
    /// A category; the empty string asks for the uncategorised.
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    /// Bounds on the signed amount, in minor units.
    #[serde(default)]
    pub min_amount: Option<i64>,
    #[serde(default)]
    pub max_amount: Option<i64>,
    /// Only the transactions with a suggestion waiting for the person.
    #[serde(default)]
    pub suggested: Option<bool>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionRow {
    pub id: String,
    pub account: String,
    pub booked_on: String,
    pub amount_minor: i64,
    pub currency: String,
    pub description: String,
    pub counterparty: String,
    pub category: String,
    pub category_source: String,
    pub suggestion: String,
    pub balance_minor: Option<i64>,
}

const COLUMNS: &str = "id, account, booked_on, amount_minor, currency, description, counterparty,
  category, category_source, suggestion, balance_minor";

fn row_of(row: &SqliteRow) -> TransactionRow {
    TransactionRow {
        id: row.get("id"),
        account: row.get("account"),
        booked_on: row.get("booked_on"),
        amount_minor: row.get("amount_minor"),
        currency: row.get("currency"),
        description: row.get("description"),
        counterparty: row.get("counterparty"),
        category: row.get("category"),
        category_source: row.get("category_source"),
        suggestion: row.get("suggestion"),
        balance_minor: row.get("balance_minor"),
    }
}

/// Newest first, at most 200 a page.
pub async fn search(
    pool: &SqlitePool,
    filter: &TransactionQuery,
) -> Result<Vec<TransactionRow>, AppError> {
    let mut clauses: Vec<String> = Vec::new();
    let mut binds: Vec<String> = Vec::new();
    if let Some(search) = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        for word in search.split_whitespace().take(6) {
            clauses
                .push("(description LIKE ? ESCAPE '\\' OR counterparty LIKE ? ESCAPE '\\')".into());
            let escaped = word
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            binds.push(format!("%{escaped}%"));
            binds.push(format!("%{escaped}%"));
        }
    }
    if let Some(category) = filter.category.as_deref() {
        clauses.push("category = ?".into());
        binds.push(category.trim().to_string());
    }
    if let Some(from) = filter.from.as_deref() {
        clauses.push("booked_on >= ?".into());
        binds.push(super::parse_day(from)?.to_string());
    }
    if let Some(to) = filter.to.as_deref() {
        clauses.push("booked_on <= ?".into());
        binds.push(super::parse_day(to)?.to_string());
    }
    if let Some(min) = filter.min_amount {
        clauses.push(format!("amount_minor >= {min}"));
    }
    if let Some(max) = filter.max_amount {
        clauses.push(format!("amount_minor <= {max}"));
    }
    if filter.suggested == Some(true) {
        clauses.push("suggestion <> '' AND category_source <> 'person'".into());
    }
    let filter_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let limit = filter.limit.unwrap_or(50).clamp(1, SEARCH_LIMIT);
    let offset = filter.offset.unwrap_or(0);
    let sql = format!(
        "SELECT {COLUMNS} FROM transactions {filter_sql} ORDER BY booked_on DESC, created_at DESC, id LIMIT {limit} OFFSET {offset}"
    );
    let mut statement = query(&sql);
    for bind in &binds {
        statement = statement.bind(bind);
    }
    Ok(statement
        .fetch_all(pool)
        .await?
        .iter()
        .map(row_of)
        .collect())
}

/// Every transaction in `[from, to]`, oldest first.
pub async fn rows_between(
    pool: &SqlitePool,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<TransactionRow>, AppError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM transactions WHERE booked_on >= ?1 AND booked_on <= ?2 ORDER BY booked_on, created_at, id"
    );
    Ok(query(&sql)
        .bind(from.to_string())
        .bind(to.to_string())
        .fetch_all(pool)
        .await?
        .iter()
        .map(row_of)
        .collect())
}

fn category_invalid() -> AppError {
    AppError::new(
        "finance_category_invalid",
        "Choose a shorter category name.",
    )
}

fn clean_category(category: &str) -> Result<String, AppError> {
    let category = super::text::clean(category, MAX_CATEGORY_CHARS + 1);
    if category.chars().count() > MAX_CATEGORY_CHARS {
        return Err(category_invalid());
    }
    Ok(category)
}

/// Files one transaction by hand. With `remember`, adds a rule for the
/// others like it. Answers how many transactions changed.
pub(super) async fn set_category(
    pool: &SqlitePool,
    id: &str,
    category: &str,
    remember: bool,
) -> Result<usize, AppError> {
    let category = clean_category(category)?;
    let row = query("SELECT description, counterparty FROM transactions WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "finance_transaction_missing",
                "This transaction is no longer here.",
            )
        })?;
    let source = if category.is_empty() { "" } else { "person" };
    let changed = query(
        "UPDATE transactions SET category = ?1, category_source = ?2, suggestion = '', updated_at = ?3
         WHERE id = ?4 AND (category IS NOT ?1 OR category_source IS NOT ?2 OR suggestion <> '')",
    )
    .bind(&category)
    .bind(source)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(id)
    .execute(pool)
    .await?
    .rows_affected() as usize;
    if remember && !category.is_empty() {
        let pattern = rules::pattern_for(
            &row.get::<String, _>("description"),
            &row.get::<String, _>("counterparty"),
        );
        if !pattern.is_empty() {
            return Ok(changed + add_rule(pool, &pattern, &category, false).await?);
        }
    }
    Ok(changed)
}

pub async fn rules(pool: &SqlitePool) -> Result<Vec<Rule>, AppError> {
    Ok(query("SELECT id, pattern, is_regex, category, position FROM finance_rules ORDER BY position, created_at")
        .fetch_all(pool)
        .await?
        .iter()
        .map(|row| Rule {
            id: row.get("id"),
            pattern: row.get("pattern"),
            is_regex: row.get::<i64, _>("is_regex") != 0,
            category: row.get("category"),
            position: row.get("position"),
        })
        .collect())
}

/// Inserts a rule at `position`, or ahead of every other rule: the person's
/// latest choice is the one they mean.
async fn insert_rule(
    pool: &SqlitePool,
    pattern: &str,
    category: &str,
    is_regex: bool,
    position: Option<i64>,
) -> Result<bool, AppError> {
    let pattern = pattern.trim();
    let category = clean_category(category)?;
    if pattern.is_empty() || category.is_empty() || pattern.chars().count() > MAX_PATTERN_CHARS {
        return Err(AppError::new(
            "finance_rule_invalid",
            "Enter some text to match and a category.",
        ));
    }
    if is_regex && !rules::valid_regex(pattern) {
        return Err(AppError::new(
            "finance_rule_regex",
            "This regular expression is not valid.",
        ));
    }
    let exists =
        query("SELECT 1 FROM finance_rules WHERE pattern = ?1 AND is_regex = ?2 AND category = ?3")
            .bind(pattern)
            .bind(i64::from(is_regex))
            .bind(&category)
            .fetch_optional(pool)
            .await?
            .is_some();
    if exists {
        return Ok(false);
    }
    let position = match position {
        Some(position) => position,
        None => query("SELECT coalesce(min(position), 0) - 1 AS p FROM finance_rules")
            .fetch_one(pool)
            .await?
            .get("p"),
    };
    query(
        "INSERT INTO finance_rules (id, pattern, is_regex, category, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(pattern)
    .bind(i64::from(is_regex))
    .bind(&category)
    .bind(position)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(true)
}

/// Adds a rule and files again what it now covers. Answers how many
/// transactions changed.
pub(super) async fn add_rule(
    pool: &SqlitePool,
    pattern: &str,
    category: &str,
    is_regex: bool,
) -> Result<usize, AppError> {
    insert_rule(pool, pattern, category, is_regex, None).await?;
    refile(pool).await
}

pub(super) async fn remove_rule(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    query("DELETE FROM finance_rules WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    refile(pool).await?;
    Ok(())
}

/// Rules from the budget engine (or any list), appended after the person's
/// own in the order given. Answers how many were new.
pub(super) async fn import_rules(
    pool: &SqlitePool,
    imported: &[(String, bool, String)],
) -> Result<usize, AppError> {
    let mut added = 0;
    let last: i64 = query("SELECT coalesce(max(position), 0) AS p FROM finance_rules")
        .fetch_one(pool)
        .await?
        .get("p");
    for (pattern, is_regex, category) in imported {
        // An unreadable line of someone else's list is left out, not fatal.
        let position = Some(last + 1 + added as i64);
        if insert_rule(pool, pattern, category, *is_regex, position)
            .await
            .unwrap_or(false)
        {
            added += 1;
        }
    }
    refile(pool).await?;
    Ok(added)
}

/// Files every transaction the person has not filed by hand with the rules
/// as they are now. Only rows whose category changes are written, so a
/// refile that changes nothing sends nothing.
pub(super) async fn refile(pool: &SqlitePool) -> Result<usize, AppError> {
    let categorizer = Categorizer::new(&rules(pool).await?);
    let rows = query("SELECT id, description, counterparty, category, category_source FROM transactions WHERE category_source <> 'person'")
        .fetch_all(pool)
        .await?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    let mut changed = 0;
    for row in &rows {
        let current: String = row.get("category");
        let source: String = row.get("category_source");
        let found = categorizer.categorize(
            &row.get::<String, _>("description"),
            &row.get::<String, _>("counterparty"),
        );
        let (category, next_source) = match found {
            Some(category) => (category, "rule"),
            // What a rule filed and no rule covers any more goes back to open.
            None if source == "rule" => (String::new(), ""),
            None => continue,
        };
        if category == current && next_source == source {
            continue;
        }
        query("UPDATE transactions SET category = ?1, category_source = ?2, updated_at = ?3 WHERE id = ?4")
            .bind(&category)
            .bind(next_source)
            .bind(&now)
            .bind(row.get::<String, _>("id"))
            .execute(&mut *tx)
            .await?;
        changed += 1;
    }
    tx.commit().await?;
    Ok(changed)
}

/// The person accepts or dismisses suggestions. Accepting files them as the
/// person's own choice.
pub(super) async fn resolve_suggestions(
    pool: &SqlitePool,
    ids: &[String],
    accept: bool,
) -> Result<usize, AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut changed = 0;
    let mut tx = pool.begin().await?;
    for id in ids.iter().take(1000) {
        let statement = if accept {
            query(
                "UPDATE transactions SET category = suggestion, category_source = 'person', suggestion = '', updated_at = ?1
                 WHERE id = ?2 AND suggestion <> ''",
            )
            .bind(&now)
            .bind(id)
        } else {
            // The suggestion is local, so dismissing it changes nothing that travels.
            query("UPDATE transactions SET suggestion = '' WHERE id = ?1 AND suggestion <> ''")
                .bind(id)
        };
        changed += statement.execute(&mut *tx).await?.rows_affected() as usize;
    }
    tx.commit().await?;
    Ok(changed)
}

pub(super) async fn forget(pool: &SqlitePool, statement_id: Option<&str>) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    match statement_id {
        Some(id) => {
            query("DELETE FROM transactions WHERE statement_id = ?1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            query("DELETE FROM bank_statements WHERE id = ?1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        None => {
            for table in ["transactions", "bank_statements", "finance_rules"] {
                query(&format!("DELETE FROM {table}"))
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Stores the model's proposals. A proposal never overwrites a category.
pub(super) async fn store_suggestions(
    pool: &SqlitePool,
    by_description: &[(String, String)],
) -> Result<usize, AppError> {
    let mut changed = 0;
    let mut tx = pool.begin().await?;
    for (description, category) in by_description {
        changed += query(
            "UPDATE transactions SET suggestion = ?1 WHERE description = ?2 AND category = '' AND suggestion = ''",
        )
        .bind(category)
        .bind(description)
        .execute(&mut *tx)
        .await?
        .rows_affected() as usize;
    }
    tx.commit().await?;
    Ok(changed)
}

/// Descriptions no rule filed and no suggestion covers yet, most frequent
/// first.
pub(super) async fn open_descriptions(
    pool: &SqlitePool,
    limit: usize,
) -> Result<Vec<String>, AppError> {
    Ok(query(
        "SELECT description FROM transactions WHERE category = '' AND suggestion = '' AND description <> ''
         GROUP BY description ORDER BY count(*) DESC, max(booked_on) DESC LIMIT ?1",
    )
    .bind(limit as i64)
    .fetch_all(pool)
    .await?
    .iter()
    .map(|row| row.get("description"))
    .collect())
}
