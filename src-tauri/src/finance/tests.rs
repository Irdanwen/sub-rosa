//! Statements read from realistic exports, the import's deduplication and
//! filing, and what may leave the device.

use super::*;
use sqlx::query::query;
use sqlx::row::Row as _;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/finance/fixtures")
        .join(name);
    std::fs::read(path).unwrap()
}

fn read_fixture(name: &str) -> ReadStatement {
    read(&fixture(name), None, None).unwrap()
}

fn day(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
}

async fn pool() -> SqlitePool {
    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    pool
}

fn request(name: &str, bytes: &[u8]) -> StatementRequest {
    StatementRequest {
        file_name: name.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mapping: None,
        account: None,
    }
}

#[test]
fn ubs_in_english_with_its_preamble() {
    let read = read_fixture("ubs-en.csv");
    assert_eq!(read.format, Format::Csv);
    assert_eq!(read.preset, "ubs");
    assert_eq!(read.account, "0230 00123456.01");
    assert_eq!(read.transactions.len(), 4);
    assert_eq!(read.skipped, 0);
    let first = &read.transactions[0];
    assert_eq!(first.booked_on, day("2026-09-29"));
    assert_eq!(first.amount_minor, -8_405);
    assert_eq!(first.currency, "CHF");
    assert_eq!(first.reference, "9930272TI3460588");
    assert_eq!(first.balance_minor, Some(396_270));
    assert!(first.description.starts_with("Migros M Lausanne Flon"));
    assert_eq!(read.transactions[2].amount_minor, 520_000);
}

#[test]
fn ubs_in_german_with_swiss_thousands() {
    let read = read_fixture("ubs-de.csv");
    assert_eq!(read.preset, "ubs");
    assert_eq!(read.transactions.len(), 2);
    assert_eq!(read.transactions[0].amount_minor, -108_405);
    assert_eq!(read.transactions[0].booked_on, day("2026-09-29"));
    assert_eq!(read.transactions[0].balance_minor, Some(396_270));
    assert_eq!(read.transactions[1].reference, "9930271SB1112223");
}

#[test]
fn postfinance_in_windows_1252_with_a_footer() {
    let read = read_fixture("postfinance-de.csv");
    assert_eq!(read.preset, "postfinance");
    assert_eq!(read.account, "CH1209000000123456789");
    assert_eq!(read.transactions.len(), 4);
    // The disclaimer's two lines are not transactions.
    assert_eq!(read.skipped, 2);
    let salary = &read.transactions[2];
    assert_eq!(salary.amount_minor, 490_000);
    assert_eq!(salary.currency, "CHF");
    assert!(salary.description.contains("LOHN SEPTEMBER"));
    assert_eq!(read.transactions[0].amount_minor, -6_340);
    assert_eq!(read.transactions[3].balance_minor, Some(-243_000));
    let layout = read.layout.unwrap();
    assert_eq!(layout.headers[1], "Avisierungstext");
}

#[test]
fn raiffeisen_with_the_iban_on_every_row() {
    let read = read_fixture("raiffeisen.csv");
    assert_eq!(read.preset, "raiffeisen");
    assert_eq!(read.account, "CH4580808001234567890");
    assert_eq!(read.transactions.len(), 3);
    assert_eq!(read.transactions[0].amount_minor, -2_385);
    assert_eq!(read.transactions[0].booked_on, day("2026-09-28"));
    assert_eq!(read.transactions[0].currency, "CHF");
}

#[test]
fn bcv_with_debit_and_credit_columns() {
    let read = read_fixture("bcv.csv");
    assert_eq!(read.preset, "bcv");
    assert_eq!(read.account, "CH9300767000E51234567");
    let amounts: Vec<i64> = read.transactions.iter().map(|tx| tx.amount_minor).collect();
    assert_eq!(amounts, vec![-185_000, -12_990, 510_000]);
    assert_eq!(read.transactions[2].balance_minor, Some(712_010));
}

#[test]
fn credit_agricole_with_quoted_line_breaks_and_decimal_commas() {
    let read = read_fixture("credit-agricole.csv");
    assert_eq!(read.preset, "credit_agricole");
    assert_eq!(read.transactions.len(), 5);
    let first = &read.transactions[0];
    assert_eq!(
        first.description,
        "CARTE X1234 27/09 CARREFOUR MARKET GRENOBLE"
    );
    assert_eq!(first.amount_minor, -4_530);
    assert_eq!(first.currency, "EUR");
    assert_eq!(read.transactions[1].amount_minor, 245_000);
    let layout = read.layout.unwrap();
    assert!(layout.mapping.decimal_comma);
    assert_eq!(layout.mapping.date_order, text::DateOrder::Dmy);
}

#[test]
fn bnp_with_a_signed_amount_column() {
    let read = read_fixture("bnp.csv");
    assert_eq!(read.preset, "bnp");
    let amounts: Vec<i64> = read.transactions.iter().map(|tx| tx.amount_minor).collect();
    assert_eq!(amounts, vec![-3_872, 245_000, -2_999]);
    assert!(read.transactions[0].description.contains("MONOPRIX"));
}

#[test]
fn a_generic_export_with_commas_and_two_currencies() {
    let read = read_fixture("generic-revolut.csv");
    assert_eq!(read.preset, "generic");
    assert_eq!(read.layout.as_ref().unwrap().mapping.delimiter, ",");
    assert_eq!(read.transactions.len(), 3);
    assert_eq!(read.transactions[0].booked_on, day("2026-09-04"));
    assert_eq!(read.transactions[2].currency, "EUR");
    assert_eq!(
        read.transactions[2].description,
        "Restaurant Le Lyrique, Genève"
    );
}

#[test]
fn a_corrected_mapping_is_the_one_used() {
    let bytes = fixture("bnp.csv");
    let detected = read(&bytes, None, None).unwrap().layout.unwrap();
    let mut mapping = detected.mapping.clone();
    mapping.description = vec![3];
    let read = read(&bytes, Some(&mapping), Some("Compte joint")).unwrap();
    assert_eq!(
        read.transactions[0].description,
        "DU 280926 MONOPRIX PARIS 11 CARTE 4974XXXXXXXX1234"
    );
    assert_eq!(read.account, "Compte joint");
    assert!(read
        .transactions
        .iter()
        .all(|tx| tx.account == "Compte joint"));
}

#[test]
fn ofx_sgml_with_decimal_commas_and_a_closing_balance() {
    let read = read_fixture("statement-sgml.ofx");
    assert_eq!(read.format, Format::Ofx);
    assert_eq!(read.account, "00012345678");
    assert_eq!(read.transactions.len(), 3);
    let card = &read.transactions[0];
    assert_eq!(card.amount_minor, -3_872);
    assert_eq!(card.currency, "EUR");
    assert_eq!(card.reference, "202609290001");
    assert_eq!(
        card.description,
        "CB MONOPRIX PARIS FACTURE CARTE DU 280926"
    );
    // Walked back from the ledger balance on the last day.
    assert_eq!(card.balance_minor, Some(123_456));
    assert_eq!(read.transactions[1].balance_minor, Some(127_328));
}

#[test]
fn ofx_xml_with_entities_and_a_payee_block() {
    let read = read_fixture("statement-xml.qfx");
    assert_eq!(read.format, Format::Ofx);
    assert_eq!(read.transactions.len(), 2);
    assert_eq!(read.transactions[0].description, "Coffee & Co");
    assert_eq!(read.transactions[0].booked_on, day("2026-09-03"));
    assert_eq!(read.transactions[1].counterparty, "ACME PAYROLL");
    assert_eq!(read.transactions[1].balance_minor, Some(408_750));
}

#[test]
fn camt_053_with_a_collective_booking_and_a_pending_one() {
    let read = read_fixture("camt053.xml");
    assert_eq!(read.format, Format::Camt053);
    assert_eq!(read.account, "CH9300762011623852957");
    // The pending reservation is not history yet.
    assert_eq!(read.transactions.len(), 3);
    assert_eq!(read.skipped, 0);
    let salary = &read.transactions[0];
    assert_eq!(salary.amount_minor, 520_000);
    assert_eq!(salary.counterparty, "Exemple SA");
    assert_eq!(salary.reference, "20260925001234567");
    assert!(salary.description.contains("Salaire septembre 2026"));
    let rent = &read.transactions[1];
    assert_eq!(rent.amount_minor, -185_000);
    assert_eq!(rent.counterparty, "Régie du Rhône SA");
    let batch = &read.transactions[2];
    assert_eq!(batch.amount_minor, -17_945);
    assert_eq!(batch.counterparty, "");
    assert_eq!(batch.description, "Achats carte de débit & TWINT");
    // Walked back from the closing balance: the opening one is met again.
    assert_eq!(batch.balance_minor, Some(617_055));
    assert_eq!(salary.balance_minor, Some(820_000));
    assert_eq!(salary.balance_minor.unwrap() - salary.amount_minor, 300_000);
}

#[test]
fn camt_053_version_8_shapes() {
    let xml = r#"<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt>
<Acct><Id><Othr><Id>123-456</Id></Othr></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">100.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Dt><Dt>2026-09-01</Dt></Dt></Bal>
<Ntry><Amt Ccy="EUR">20.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><DtTm>2026-09-03T10:00:00</DtTm></BookgDt>
<NtryDtls><TxDtls><RltdPties><Cdtr><Pty><Nm>Boulangerie Paul</Nm></Pty></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>"#;
    let read = read(xml.as_bytes(), None, None).unwrap();
    assert_eq!(read.account, "123-456");
    let tx = &read.transactions[0];
    assert_eq!((tx.amount_minor, tx.booked_on), (-2_000, day("2026-09-03")));
    assert_eq!(tx.counterparty, "Boulangerie Paul");
    assert_eq!(tx.currency, "EUR");
    // An overdrawn opening balance, walked forward.
    assert_eq!(tx.balance_minor, Some(-12_000));
}

#[test]
fn what_cannot_be_read_says_so() {
    assert_eq!(
        read(b"<Document><Unrelated/></Document> camt.053", None, None)
            .unwrap_err()
            .code,
        "finance_statement_invalid"
    );
    assert_eq!(
        read(b"OFXHEADER:100\nnothing", None, None)
            .unwrap_err()
            .code,
        "finance_statement_invalid"
    );
    let csv = read(b"just,some\nwords,here\n", None, None).unwrap();
    assert!(csv.transactions.is_empty());
    assert_eq!(
        read(&vec![b'a'; MAX_FILE_BYTES + 1], None, None)
            .unwrap_err()
            .code,
        "finance_statement_too_large"
    );
}

#[test]
fn identical_lines_in_one_file_stay_two_and_a_reference_wins() {
    let read = read_fixture("credit-agricole.csv");
    let keys = store::dedup_keys(&read.transactions);
    assert_eq!(keys.len(), 5);
    let distinct: std::collections::HashSet<&String> = keys.iter().collect();
    assert_eq!(distinct.len(), 5);
    assert!(keys.iter().all(|key| key.starts_with("h:")));
    let ubs = read_fixture("ubs-en.csv");
    assert!(store::dedup_keys(&ubs.transactions)[0]
        .starts_with("ref:023000123456.01:9930272TI3460588:"));
    // The same file read again makes the same keys.
    assert_eq!(
        keys,
        store::dedup_keys(&read_fixture("credit-agricole.csv").transactions)
    );
}

#[tokio::test]
async fn importing_again_adds_only_what_is_new() {
    let pool = pool().await;
    let bytes = fixture("credit-agricole.csv");
    let first = import(&pool, &request("releve.csv", &bytes)).await.unwrap();
    assert_eq!((first.added, first.skipped), (5, 0));
    // Carrefour, EDF, the bakery twice and the salary are all known merchants.
    assert_eq!(first.categorized, 5);

    let again = preview(&pool, &request("releve.csv", &bytes))
        .await
        .unwrap();
    assert!(again.already_imported);
    assert_eq!((again.count, again.new_count), (5, 0));
    let second = import(&pool, &request("releve.csv", &bytes)).await.unwrap();
    assert_eq!((second.added, second.skipped), (0, 5));

    // An overlapping export with one more day.
    let extended = crate::finance::text::decode(&bytes)
        + "30/09/2026;\"CARTE X1234 29/09 SNCF INTERNET\";89,00;;\r\n";
    let overlap = import(&pool, &request("releve-2.csv", extended.as_bytes()))
        .await
        .unwrap();
    assert_eq!(overlap.added, 1);

    let rows = store::search(&pool, &TransactionQuery::default())
        .await
        .unwrap();
    assert_eq!(rows.len(), 6);
    let sncf = rows
        .iter()
        .find(|row| row.description.contains("SNCF"))
        .unwrap();
    assert_eq!(
        (sncf.category.as_str(), sncf.category_source.as_str()),
        ("transport", "rule")
    );
    let ids: std::collections::HashSet<&String> = rows.iter().map(|row| &row.id).collect();
    assert_eq!(ids.len(), 6);
}

#[tokio::test]
async fn a_persons_choice_outlives_every_rule() {
    let pool = pool().await;
    import(&pool, &request("ubs.csv", &fixture("ubs-en.csv")))
        .await
        .unwrap();
    let rows = store::search(&pool, &TransactionQuery::default())
        .await
        .unwrap();
    let migros = rows
        .iter()
        .find(|row| row.description.starts_with("Migros"))
        .unwrap();
    assert_eq!(migros.category, "groceries");

    // Filed by hand, and remembered as a rule.
    store::set_category(&pool, &migros.id, "household", true)
        .await
        .unwrap();
    let rules = store::rules(&pool).await.unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].category, "household");

    // A later rule does not move what the person filed.
    store::add_rule(&pool, "migros", "dining", false)
        .await
        .unwrap();
    let again = store::search(
        &pool,
        &TransactionQuery {
            search: Some("Migros".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (
            again[0].category.as_str(),
            again[0].category_source.as_str()
        ),
        ("household", "person")
    );

    // A rule-filed row follows the rules; removing the rule reopens it.
    let tax = rows
        .iter()
        .find(|row| row.description.starts_with("Steuerverwaltung"))
        .unwrap();
    assert_eq!(tax.category, "taxes");
    store::add_rule(&pool, "steuerverwaltung", "housing", false)
        .await
        .unwrap();
    let tax_rows = store::search(
        &pool,
        &TransactionQuery {
            search: Some("Steuerverwaltung".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(tax_rows[0].category, "housing");
    let rule = store::rules(&pool)
        .await
        .unwrap()
        .into_iter()
        .find(|rule| rule.pattern == "steuerverwaltung")
        .unwrap();
    store::remove_rule(&pool, &rule.id).await.unwrap();
    let tax_rows = store::search(
        &pool,
        &TransactionQuery {
            search: Some("Steuerverwaltung".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(tax_rows[0].category, "taxes");
    assert!(store::add_rule(&pool, "([", "x", true).await.is_err());
    assert!(store::add_rule(&pool, " ", "x", false).await.is_err());
}

#[tokio::test]
async fn suggestions_wait_for_the_person() {
    let pool = pool().await;
    import(
        &pool,
        &request("revolut.csv", &fixture("generic-revolut.csv")),
    )
    .await
    .unwrap();
    // Spotify and the restaurant are known merchants; the top-up is not.
    let open = store::open_descriptions(&pool, 10).await.unwrap();
    assert_eq!(open, vec!["Top-up by *1234".to_string()]);
    let proposals = vec![
        ("Top-up by *1234".to_string(), "transfers".to_string()),
        ("Not a description here".to_string(), "fees".to_string()),
    ];
    assert_eq!(
        store::store_suggestions(&pool, &proposals).await.unwrap(),
        1
    );
    assert_eq!(store::status(&pool).await.unwrap().suggestions, 1);
    let suggested = store::search(
        &pool,
        &TransactionQuery {
            suggested: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(suggested.len(), 1);
    // Nothing is filed on the model's word alone.
    assert_eq!(
        (
            suggested[0].category.as_str(),
            suggested[0].suggestion.as_str()
        ),
        ("", "transfers")
    );
    assert!(store::open_descriptions(&pool, 10)
        .await
        .unwrap()
        .is_empty());

    assert_eq!(
        store::resolve_suggestions(&pool, &[suggested[0].id.clone()], false)
            .await
            .unwrap(),
        1
    );
    let dismissed = store::search(
        &pool,
        &TransactionQuery {
            category: Some(String::new()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (
            dismissed[0].category.as_str(),
            dismissed[0].suggestion.as_str()
        ),
        ("", "")
    );

    store::store_suggestions(&pool, &proposals).await.unwrap();
    assert_eq!(
        store::resolve_suggestions(&pool, &[suggested[0].id.clone()], true)
            .await
            .unwrap(),
        1
    );
    let accepted = store::search(
        &pool,
        &TransactionQuery {
            search: Some("Top-up".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (
            accepted[0].category.as_str(),
            accepted[0].category_source.as_str()
        ),
        ("transfers", "person")
    );
    assert_eq!(store::status(&pool).await.unwrap().suggestions, 0);
}

#[tokio::test]
async fn finances_leave_the_device_only_once_sync_is_on() {
    let pool = pool().await;
    query("UPDATE account_sync_control SET account_id='account-one' WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    let outbox = |pool: SqlitePool| async move {
        query("SELECT count(*) AS n FROM account_sync_outbox WHERE json_extract(body,'$.table') IN ('transactions','finance_rules')")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i64, _>("n")
    };
    import(&pool, &request("bnp.csv", &fixture("bnp.csv")))
        .await
        .unwrap();
    store::add_rule(&pool, "sfr", "utilities", false)
        .await
        .unwrap();
    assert_eq!(outbox(pool.clone()).await, 0);

    store::set_sync(&pool, true).await.unwrap();
    for table in ["finance_rules", "transactions"] {
        crate::account::sync::enqueue_existing(&pool, table, "1=1")
            .await
            .unwrap();
    }
    assert_eq!(outbox(pool.clone()).await, 4);
    // Once on, a new edit queues on its own; the local suggestion does not travel.
    let row = store::search(&pool, &TransactionQuery::default())
        .await
        .unwrap()
        .remove(0);
    store::set_category(&pool, &row.id, "dining", false)
        .await
        .unwrap();
    let body: String = query(
        "SELECT body FROM account_sync_outbox WHERE object_id = ?1 ORDER BY sequence DESC LIMIT 1",
    )
    .bind(&row.id)
    .fetch_one(&pool)
    .await
    .unwrap()
    .get("body");
    let body: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["row"]["category"], "dining");
    assert!(body["row"].get("suggestion").is_none());
    assert!(body["row"].get("statement_id").is_none());
}

#[tokio::test]
async fn forgetting_a_statement_takes_its_transactions() {
    let pool = pool().await;
    let first = import(&pool, &request("bnp.csv", &fixture("bnp.csv")))
        .await
        .unwrap();
    import(&pool, &request("bcv.csv", &fixture("bcv.csv")))
        .await
        .unwrap();
    store::forget(&pool, Some(&first.statement_id))
        .await
        .unwrap();
    let status = store::status(&pool).await.unwrap();
    assert_eq!((status.transactions, status.statements.len()), (3, 1));
    store::forget(&pool, None).await.unwrap();
    assert_eq!(store::status(&pool).await.unwrap().transactions, 0);
}

#[tokio::test]
async fn the_tools_read_what_was_imported() {
    let pool = pool().await;
    import(&pool, &request("ubs.csv", &fixture("ubs-en.csv")))
        .await
        .unwrap();
    let spending = tool::spending(
        &pool,
        &serde_json::json!({ "from": "2026-09-01", "to": "2026-09-30" }),
    )
    .await
    .unwrap();
    assert_eq!(spending["currency"], "CHF");
    assert_eq!(spending["income"], 5200.0);
    assert_eq!(spending["spending"], 84.05 + 1850.0 + 3823.6);
    assert_eq!(spending["balance"]["amount"], 3962.7);
    assert_eq!(spending["balance"]["stated"], true);
    let found = tool::search(
        &pool,
        &serde_json::json!({ "query": "loyer", "max_amount": -100 }),
    )
    .await
    .unwrap();
    assert_eq!(found["count"], 1);
    assert_eq!(found["transactions"][0]["amount"], -1850.0);
    let none = tool::search(&pool, &serde_json::json!({ "category": "" }))
        .await
        .unwrap();
    assert_eq!(none["count"], 0);
}
