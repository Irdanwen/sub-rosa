//! The council's durable rows (ADR-0034): what a resume reads, and what it
//! must never re-buy.

use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use os_june_lib::domain::types::{
    AcceptanceCriterionDto, CouncilQuestionDto, CouncilSeatDto, CouncilVerdictBody,
    CriterionVerdictDto, MandateDto, VerdictFindingDto,
};
use sqlx::query::query;
use sqlx_sqlite::SqlitePoolOptions;

async fn repos() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("sqlite memory");
    run_migrations(&pool).await.expect("migrations");
    Repositories::new(pool)
}

fn seats() -> Vec<CouncilSeatDto> {
    vec![
        CouncilSeatDto {
            id: "shape".into(),
            name: "Shape".into(),
            role: "position".into(),
            charge: "What is actually being asked for.".into(),
            model: "zai-org-glm-5-2".into(),
            model_family: "glm".into(),
        },
        CouncilSeatDto {
            id: "risk".into(),
            name: "Risk".into(),
            role: "position".into(),
            charge: "What breaks.".into(),
            model: "kimi-k2-6".into(),
            model_family: "kimi".into(),
        },
    ]
}

async fn open(repos: &Repositories, id: &str) {
    let seats_json = serde_json::to_string(&seats()).expect("seats");
    repos
        .begin_council_mandate(
            id,
            "decision",
            "make the settings page load faster",
            &seats_json,
            Some("working folder: /tmp/app"),
            Some("/tmp/app"),
            "council-v1",
        )
        .await
        .expect("begin");
}

#[tokio::test]
async fn a_cycle_opens_before_any_model_call() {
    let repos = repos().await;
    open(&repos, "m1").await;

    let row = repos
        .council_mandate("m1")
        .await
        .expect("read")
        .expect("row");
    assert_eq!(row.status, "deliberating");
    assert_eq!(row.round, 0);
    assert_eq!(row.model_calls, 0);
    assert_eq!(row.seats.len(), 2);
    assert_eq!(row.seats[1].model_family, "kimi");
    assert!(row.mandate.is_none());
    assert_eq!(row.working_dir.as_deref(), Some("/tmp/app"));
}

#[tokio::test]
async fn a_recorded_seat_is_never_bought_twice() {
    let repos = repos().await;
    open(&repos, "m1").await;

    for _ in 0..3 {
        repos
            .record_council_turn("m1", 0, "blind", "shape", "zai-org-glm-5-2", "{}", false)
            .await
            .expect("record");
    }

    let turns = repos.council_turns("m1", 0, "blind").await.expect("turns");
    assert_eq!(
        turns.len(),
        1,
        "the primary key is what makes a re-drive idempotent"
    );
    // The count still rises: three calls really were paid for, and pretending
    // otherwise would under-report the spend.
    let row = repos
        .council_mandate("m1")
        .await
        .expect("read")
        .expect("row");
    assert_eq!(row.model_calls, 3);
}

#[tokio::test]
async fn turns_are_scoped_to_their_round_and_phase() {
    let repos = repos().await;
    open(&repos, "m1").await;

    repos
        .record_council_turn("m1", 0, "blind", "shape", "a", "first", false)
        .await
        .expect("record");
    repos
        .record_council_turn("m1", 0, "contradiction", "shape", "a", "second", false)
        .await
        .expect("record");
    repos
        .record_council_turn("m1", 1, "blind", "shape", "a", "retake", false)
        .await
        .expect("record");

    assert_eq!(
        repos.council_turns("m1", 0, "blind").await.unwrap()[0].content,
        "first"
    );
    assert_eq!(
        repos.council_turns("m1", 0, "contradiction").await.unwrap()[0].content,
        "second"
    );
    assert_eq!(
        repos.council_turns("m1", 1, "blind").await.unwrap()[0].content,
        "retake"
    );
}

#[tokio::test]
async fn a_failed_seat_is_recorded_rather_than_lost() {
    let repos = repos().await;
    open(&repos, "m1").await;
    repos
        .record_council_turn("m1", 0, "blind", "risk", "kimi-k2-6", "", true)
        .await
        .expect("record");

    let turns = repos.council_turns("m1", 0, "blind").await.expect("turns");
    assert!(
        turns[0].failed,
        "a council that lost a seat must be able to say so"
    );
}

#[tokio::test]
async fn issuing_stores_the_slots_and_the_exact_string() {
    let repos = repos().await;
    open(&repos, "m1").await;

    let mandate = MandateDto {
        objective: "Cut settings page load to under 300ms".into(),
        deliverable: vec!["src/components/settings/AppSettings.tsx".into()],
        constraints: vec!["No change to the settings schema".into()],
        acceptance: vec![AcceptanceCriterionDto {
            statement: "The settings page paints in under 300ms on a cold open".into(),
            verified_by: "performance.now() around the first render, logged".into(),
        }],
        out_of_scope: vec!["The mobile settings list".into()],
        first_step: "Measure the current load".into(),
    };
    let json = serde_json::to_string(&mandate).expect("mandate");
    let row = repos
        .set_council_mandate_issued(
            "m1",
            &json,
            "RENDERED PROMPT",
            r#"["Risk wanted a stricter budget, Shape won"]"#,
            r#"["nine deliverables were proposed and the last four were dropped"]"#,
        )
        .await
        .expect("issue")
        .expect("row");

    assert_eq!(row.status, "ready");
    assert_eq!(row.rendered_prompt.as_deref(), Some("RENDERED PROMPT"));
    let stored = row.mandate.expect("slots");
    assert_eq!(stored, mandate);
    assert_eq!(
        stored.acceptance[0].verified_by,
        "performance.now() around the first render, logged"
    );
    assert_eq!(
        row.dissent.len(),
        1,
        "the user is the person who can settle a disagreement"
    );
    assert_eq!(
        row.cuts.len(),
        1,
        "a cut nobody is told about reads as no cut at all"
    );
}

#[tokio::test]
async fn questions_carry_their_answers_back() {
    let repos = repos().await;
    open(&repos, "m1").await;

    let asked = vec![CouncilQuestionDto {
        id: "q1".into(),
        question: "Which page is slow, settings or the notes list?".into(),
        raised_by: 2,
        answer: None,
    }];
    repos
        .set_council_questions("m1", &serde_json::to_string(&asked).unwrap(), "questions")
        .await
        .expect("ask");

    let mut answered = asked.clone();
    answered[0].answer = Some("Settings.".into());
    let row = repos
        .set_council_questions(
            "m1",
            &serde_json::to_string(&answered).unwrap(),
            "deliberating",
        )
        .await
        .expect("answer")
        .expect("row");

    assert_eq!(row.status, "deliberating");
    assert_eq!(row.questions[0].raised_by, 2);
    assert_eq!(row.questions[0].answer.as_deref(), Some("Settings."));
}

#[tokio::test]
async fn a_session_finds_the_cycle_it_is_executing() {
    let repos = repos().await;
    open(&repos, "m1").await;
    repos
        .set_council_mandate_session(
            "m1",
            "sess-9",
            None,
            Some("abc123"),
            Some("zai-org-glm-5-2"),
        )
        .await
        .expect("bind");

    let found = repos
        .council_mandate_for_session("sess-9")
        .await
        .expect("lookup")
        .expect("row");
    assert_eq!(found.id, "m1");
    assert_eq!(found.status, "executing");
    // Binding a session must not erase the folder the deliberation recorded.
    assert_eq!(found.working_dir.as_deref(), Some("/tmp/app"));
    assert_eq!(
        found.base_commit.as_deref(),
        Some("abc123"),
        "a verdict that diffs against the wrong base looks like an answer"
    );
}

#[tokio::test]
async fn each_round_keeps_its_own_verdict() {
    let repos = repos().await;
    open(&repos, "m1").await;

    for round in 0..2 {
        repos
            .begin_council_verdict("m1", round, Some("sess-9"), "council-v1")
            .await
            .expect("begin verdict");
        let body = CouncilVerdictBody {
            criteria: vec![CriterionVerdictDto {
                statement: format!("criterion of round {round}"),
                status: if round == 0 {
                    "unsatisfied"
                } else {
                    "satisfied"
                }
                .into(),
                evidence: "src/x.ts:12".into(),
                seat: "conformance".into(),
            }],
            findings: vec![VerdictFindingDto {
                kind: "collateral".into(),
                summary: "package.json was reformatted".into(),
                evidence: "git diff package.json".into(),
                seat: "collateral".into(),
            }],
            summary: Some(format!("round {round}")),
        };
        repos
            .set_council_verdict_ready("m1", round, &serde_json::to_string(&body).unwrap())
            .await
            .expect("ready");
    }

    let all = repos.council_verdicts("m1").await.expect("verdicts");
    assert_eq!(
        all.len(),
        2,
        "a retake must not overwrite the verdict that prompted it"
    );
    assert_eq!(all[0].criteria[0].status, "unsatisfied");
    assert_eq!(all[1].criteria[0].status, "satisfied");
    assert_eq!(all[0].findings[0].kind, "collateral");
}

#[tokio::test]
async fn the_sweep_picks_up_deliberations_but_not_running_sessions() {
    let repos = repos().await;
    open(&repos, "deliberating").await;
    open(&repos, "executing").await;
    open(&repos, "settled").await;
    repos
        .set_council_mandate_session("executing", "sess-1", None, None, None)
        .await
        .expect("bind");
    repos
        .set_council_mandate_status("settled", "settled")
        .await
        .expect("settle");

    let unfinished = repos
        .unfinished_council_mandates()
        .await
        .expect("unfinished");
    assert_eq!(unfinished, vec!["deliberating".to_string()]);
}

#[tokio::test]
async fn a_cycle_under_review_is_driven_by_its_verdict_row_alone() {
    let repos = repos().await;
    open(&repos, "m1").await;
    repos
        .begin_council_verdict("m1", 0, Some("sess-9"), "council-v1")
        .await
        .expect("verdict");
    repos
        .set_council_mandate_status("m1", "reviewing")
        .await
        .expect("review");

    // Exactly one owner: the verdict row. Waking it from both places would run
    // one verdict twice and bill for both.
    assert!(repos
        .unfinished_council_mandates()
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        repos.unfinished_council_verdicts().await.unwrap(),
        vec![("m1".to_string(), 0)]
    );
}

#[tokio::test]
async fn a_verdict_records_the_prompts_that_produced_it() {
    let repos = repos().await;
    open(&repos, "m1").await;
    repos
        .begin_council_verdict("m1", 0, None, "council-v1")
        .await
        .expect("first");
    // A retake landing after an app update carries the newer version.
    repos
        .begin_council_verdict("m1", 1, None, "council-v2")
        .await
        .expect("retake");

    let all = repos.council_verdicts("m1").await.expect("verdicts");
    assert_eq!(all[0].prompt_version, "council-v1");
    assert_eq!(all[1].prompt_version, "council-v2");
}

#[tokio::test]
async fn deleting_a_cycle_takes_its_turns_and_verdicts_with_it() {
    let repos = repos().await;
    open(&repos, "m1").await;
    repos
        .record_council_turn("m1", 0, "blind", "shape", "a", "{}", false)
        .await
        .expect("record");
    repos
        .begin_council_verdict("m1", 0, None, "council-v1")
        .await
        .expect("verdict");

    repos.delete_council_mandate("m1").await.expect("delete");

    assert!(repos.council_mandate("m1").await.expect("read").is_none());
    assert!(repos
        .council_turns("m1", 0, "blind")
        .await
        .expect("turns")
        .is_empty());
    assert!(repos
        .council_verdicts("m1")
        .await
        .expect("verdicts")
        .is_empty());
}

#[tokio::test]
async fn a_malformed_blob_degrades_to_empty_rather_than_to_an_error() {
    let repos = repos().await;
    let pool = repos.pool.clone();
    let now = "2026-08-28T00:00:00.000Z";
    query(
        "INSERT INTO council_mandates (id, council_id, request, status, seats_json, questions_json, mandate_json, round, model_calls, prompt_version, created_at, updated_at)
         VALUES ('bad', 'decision', 'x', 'deliberating', 'not json', '{{{', 'nope', 0, 0, 'council-v1', ?, ?)",
    )
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .expect("insert");

    let row = repos
        .council_mandate("bad")
        .await
        .expect("a broken blob must not break the read")
        .expect("row");
    assert!(row.seats.is_empty());
    assert!(row.questions.is_empty());
    assert!(row.mandate.is_none());
}
