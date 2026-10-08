//! What the transactions say, as pure functions: spending by month and by
//! category, the merchants the money goes to, and the balance over time.
//! The Finances view draws these and the assistant's tools read them, so
//! both say the same thing.

use super::store::TransactionRow;
use super::text::normalize;
use super::NOT_SPENDING;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

const TOP_MERCHANTS: usize = 10;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryAmount {
    /// Empty for what has no category yet.
    pub category: String,
    pub amount_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthSpending {
    /// `YYYY-MM`.
    pub month: String,
    pub spending_minor: i64,
    pub income_minor: i64,
    pub by_category: Vec<CategoryAmount>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MerchantAmount {
    pub name: String,
    pub amount_minor: i64,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalancePoint {
    pub day: String,
    pub balance_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// The currency every figure is in: the one asked for, or the one most
    /// transactions use. Other currencies are listed, never added in.
    pub currency: String,
    pub currencies: Vec<String>,
    pub transactions: usize,
    /// Money out, as a positive amount, without transfers and savings.
    pub spending_minor: i64,
    pub income_minor: i64,
    pub months: Vec<MonthSpending>,
    /// Spending by category, largest first.
    pub categories: Vec<CategoryAmount>,
    pub merchants: Vec<MerchantAmount>,
    pub balance: Vec<BalancePoint>,
    /// False when no statement stated a balance: the line is then the net
    /// flow since the first transaction, not money in the account.
    pub balance_known: bool,
}

fn spends(row: &TransactionRow) -> bool {
    row.amount_minor < 0 && !NOT_SPENDING.contains(&row.category.as_str())
}

fn earns(row: &TransactionRow) -> bool {
    row.amount_minor > 0 && !NOT_SPENDING.contains(&row.category.as_str())
}

fn sorted(totals: HashMap<String, i64>) -> Vec<CategoryAmount> {
    let mut list: Vec<CategoryAmount> = totals
        .into_iter()
        .map(|(category, amount_minor)| CategoryAmount {
            category,
            amount_minor,
        })
        .collect();
    list.sort_by(|a, b| {
        b.amount_minor
            .cmp(&a.amount_minor)
            .then(a.category.cmp(&b.category))
    });
    list
}

/// The currency most rows use.
pub fn main_currency(rows: &[TransactionRow]) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for row in rows {
        *counts.entry(row.currency.as_str()).or_default() += 1;
    }
    let mut ranked: Vec<(&str, usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    ranked
        .first()
        .map(|(currency, _)| currency.to_string())
        .unwrap_or_default()
}

/// Summarises `rows` (oldest first) in `currency`, or in the main one.
pub fn overview(rows: &[TransactionRow], currency: Option<&str>) -> Overview {
    let currency = currency
        .map(str::to_string)
        .unwrap_or_else(|| main_currency(rows));
    let mut currencies: Vec<String> = rows.iter().map(|row| row.currency.clone()).collect();
    currencies.sort();
    currencies.dedup();
    let own: Vec<&TransactionRow> = rows.iter().filter(|row| row.currency == currency).collect();

    let mut months: BTreeMap<String, (i64, i64, HashMap<String, i64>)> = BTreeMap::new();
    let mut categories: HashMap<String, i64> = HashMap::new();
    let mut merchants: HashMap<String, MerchantAmount> = HashMap::new();
    let (mut spending, mut income) = (0i64, 0i64);
    for row in &own {
        let month = row.booked_on.chars().take(7).collect::<String>();
        let entry = months.entry(month).or_default();
        if spends(row) {
            let amount = -row.amount_minor;
            spending += amount;
            entry.0 += amount;
            *entry.2.entry(row.category.clone()).or_default() += amount;
            *categories.entry(row.category.clone()).or_default() += amount;
            let name = super::rules::pattern_for(&row.description, &row.counterparty);
            let merchant = merchants.entry(normalize(&name)).or_insert(MerchantAmount {
                name,
                amount_minor: 0,
                count: 0,
            });
            merchant.amount_minor += amount;
            merchant.count += 1;
        } else if earns(row) {
            income += row.amount_minor;
            entry.1 += row.amount_minor;
        }
    }
    let mut merchants: Vec<MerchantAmount> = merchants
        .into_iter()
        .filter(|(key, _)| !key.is_empty())
        .map(|(_, merchant)| merchant)
        .collect();
    merchants.sort_by(|a, b| {
        b.amount_minor
            .cmp(&a.amount_minor)
            .then(a.name.cmp(&b.name))
    });
    merchants.truncate(TOP_MERCHANTS);
    let (balance, balance_known) = balance_series(&own);
    Overview {
        currency,
        currencies,
        transactions: own.len(),
        spending_minor: spending,
        income_minor: income,
        months: months
            .into_iter()
            .map(
                |(month, (spending_minor, income_minor, by_category))| MonthSpending {
                    month,
                    spending_minor,
                    income_minor,
                    by_category: sorted(by_category),
                },
            )
            .collect(),
        categories: sorted(categories),
        merchants,
        balance,
        balance_known,
    }
}

/// One point a day. With stated balances, each account's latest known
/// balance carried forward and added across accounts; without, the running
/// sum of the amounts.
pub fn balance_series(rows: &[&TransactionRow]) -> (Vec<BalancePoint>, bool) {
    let known = rows.iter().any(|row| row.balance_minor.is_some());
    let mut days: BTreeMap<&str, i64> = BTreeMap::new();
    if known {
        let mut latest: HashMap<&str, i64> = HashMap::new();
        for row in rows {
            if let Some(balance) = row.balance_minor {
                latest.insert(row.account.as_str(), balance);
            }
            days.insert(row.booked_on.as_str(), latest.values().sum());
        }
    } else {
        let mut running = 0i64;
        for row in rows {
            running += row.amount_minor;
            days.insert(row.booked_on.as_str(), running);
        }
    }
    let points = days
        .into_iter()
        .map(|(day, balance_minor)| BalancePoint {
            day: day.to_string(),
            balance_minor,
        })
        .collect();
    (points, known)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn row(day: &str, amount: i64, category: &str, description: &str) -> TransactionRow {
        TransactionRow {
            id: format!("{day}{amount}{description}"),
            account: "CH93".into(),
            booked_on: day.into(),
            amount_minor: amount,
            currency: "CHF".into(),
            description: description.into(),
            counterparty: String::new(),
            category: category.into(),
            category_source: "rule".into(),
            suggestion: String::new(),
            balance_minor: None,
        }
    }

    #[test]
    fn spending_leaves_transfers_and_income_out() {
        let rows = vec![
            row("2026-09-01", 520_000, "income", "Salaire"),
            row("2026-09-02", -8_450, "groceries", "Migros M Lausanne"),
            row(
                "2026-09-03",
                -100_000,
                "transfers",
                "Virement compte epargne",
            ),
            row("2026-09-15", -4_200, "groceries", "Migros M Lausanne"),
            row("2026-10-01", -180_000, "housing", "Loyer octobre"),
            row("2026-10-02", -1_250, "", "Kiosk"),
        ];
        let overview = overview(&rows, None);
        assert_eq!(overview.currency, "CHF");
        assert_eq!(overview.spending_minor, 8_450 + 4_200 + 180_000 + 1_250);
        assert_eq!(overview.income_minor, 520_000);
        assert_eq!(overview.months.len(), 2);
        assert_eq!(overview.months[0].month, "2026-09");
        assert_eq!(overview.months[0].spending_minor, 12_650);
        assert_eq!(overview.categories[0].category, "housing");
        assert!(overview
            .categories
            .iter()
            .any(|c| c.category.is_empty() && c.amount_minor == 1_250));
        let migros = overview
            .merchants
            .iter()
            .find(|m| m.name.starts_with("Migros"))
            .unwrap();
        assert_eq!((migros.amount_minor, migros.count), (12_650, 2));
    }

    #[test]
    fn another_currency_is_listed_never_added() {
        let mut euro = row("2026-09-05", -5_000, "travel", "Hotel Lyon");
        euro.currency = "EUR".into();
        let rows = vec![
            row("2026-09-02", -1_000, "dining", "Cafe"),
            row("2026-09-03", -2_000, "dining", "Cafe"),
            euro,
        ];
        let overview = overview(&rows, None);
        assert_eq!(overview.currencies, vec!["CHF", "EUR"]);
        assert_eq!(overview.spending_minor, 3_000);
        let in_euro = super::overview(&rows, Some("EUR"));
        assert_eq!(in_euro.spending_minor, 5_000);
    }

    #[test]
    fn stated_balances_carry_forward_across_accounts() {
        let mut first = row("2026-09-01", -1_000, "", "A");
        first.balance_minor = Some(10_000);
        let mut second = row("2026-09-02", -500, "", "B");
        second.account = "FR76".into();
        second.balance_minor = Some(2_000);
        let mut third = row("2026-09-03", -1_000, "", "C");
        third.balance_minor = Some(9_000);
        let rows = [&first, &second, &third];
        let (points, known) = balance_series(&rows);
        assert!(known);
        let values: Vec<i64> = points.iter().map(|p| p.balance_minor).collect();
        assert_eq!(values, vec![10_000, 12_000, 11_000]);
    }

    #[test]
    fn without_balances_the_line_is_the_net_flow() {
        let first = row("2026-09-01", 1_000, "", "A");
        let second = row("2026-09-01", -300, "", "B");
        let third = row("2026-09-04", -200, "", "C");
        let (points, known) = balance_series(&[&first, &second, &third]);
        assert!(!known);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].balance_minor, 700);
        assert_eq!(points[1].balance_minor, 500);
    }
}
