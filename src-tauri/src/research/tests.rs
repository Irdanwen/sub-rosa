//! Deep research: the engine against a scripted backend (searches, page
//! reads and completions answered from tables, every call counted), the
//! citations the app resolves, the plan and the estimate.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use sqlx_sqlite::SqlitePool;
use tokio::sync::Notify;

use super::engine::{self, Advanced, Backend, StopSignal};
use super::report::{self, HandedSource};
use super::store::{self, Found, RunRow};
use super::*;

async fn pool() -> SqlitePool {
    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    pool
}

fn web(url: &str, title: &str) -> Found {
    Found {
        kind: "web",
        key: backend::source_key(url),
        title: title.into(),
        url: Some(url.into()),
        note_id: None,
        excerpt: None,
    }
}

/// A backend that answers from tables and remembers what it was asked.
#[derive(Default)]
struct Scripted {
    results: HashMap<String, Vec<Found>>,
    pages: HashMap<String, String>,
    own: Vec<Found>,
    report: String,
    searches: Mutex<Vec<String>>,
    fetched: Mutex<Vec<String>>,
    completions: AtomicUsize,
    report_prompt: Mutex<String>,
    saved: Mutex<Vec<(String, String)>>,
    /// Pages that never answer, to stop a run in the middle of a read.
    hang_on: Option<String>,
    hanging: Arc<Notify>,
}

impl Backend for Scripted {
    async fn complete(&self, system: &str, user: &str, _max: u32) -> Result<String, AppError> {
        self.completions.fetch_add(1, Ordering::SeqCst);
        if system == prompts::REPORT_SYSTEM {
            *self.report_prompt.lock().unwrap() = user.to_string();
            return Ok(self.report.clone());
        }
        if user.contains("COOKIE WALL") {
            return Ok("IRRELEVANT".into());
        }
        let source = user
            .lines()
            .find_map(|line| line.strip_prefix("Source: "))
            .unwrap_or("?");
        Ok(format!("- Notes on {source}"))
    }

    async fn web_search(&self, query: &str, _limit: usize) -> Result<Vec<Found>, AppError> {
        self.searches.lock().unwrap().push(query.to_string());
        if query == "offline" {
            return Err(AppError::new("network", "offline"));
        }
        Ok(self.results.get(query).cloned().unwrap_or_default())
    }

    async fn fetch_page(&self, url: &str) -> Result<Option<String>, AppError> {
        if self.hang_on.as_deref() == Some(url) {
            self.hanging.notify_one();
            std::future::pending::<()>().await;
        }
        self.fetched.lock().unwrap().push(url.to_string());
        Ok(self.pages.get(url).cloned())
    }

    async fn own_sources(&self, run: &RunRow, query: &str) -> Vec<Found> {
        if !run.use_notes || !query.contains("cost") {
            return Vec::new();
        }
        self.own.clone()
    }

    async fn save_report(&self, title: &str, body: &str) -> Result<String, AppError> {
        self.saved
            .lock()
            .unwrap()
            .push((title.to_string(), body.to_string()));
        Ok("note-report".into())
    }
}

fn plan() -> ResearchPlan {
    ResearchPlan {
        title: "Heat pumps in old houses".into(),
        sections: vec![
            PlanSection {
                title: "How well they work".into(),
                queries: vec!["heat pump old house efficiency".into()],
            },
            PlanSection {
                title: "What they cost".into(),
                queries: vec![
                    "heat pump cost retrofit".into(),
                    "heat pump subsidies".into(),
                ],
            },
        ],
    }
}

fn scripted() -> Scripted {
    let mut backend = Scripted::default();
    backend.results.insert(
        "heat pump old house efficiency".into(),
        vec![
            web("https://a.example/study", "Field study"),
            web("https://b.example/blocked", "Blocked page"),
            web("https://c.example/cookies", "Cookie page"),
        ],
    );
    backend.results.insert(
        "heat pump cost retrofit".into(),
        vec![
            // The same page again, with a fragment: filed once.
            web("https://a.example/study#costs", "Field study again"),
            web("https://d.example/prices", "Price survey"),
        ],
    );
    backend.pages.insert(
        "https://a.example/study".into(),
        "COP of 3.1 in houses built before 1950.".into(),
    );
    backend.pages.insert(
        "https://c.example/cookies".into(),
        "COOKIE WALL accept all".into(),
    );
    backend.pages.insert(
        "https://d.example/prices".into(),
        "Retrofits cost 12 000 to 18 000 euros.".into(),
    );
    backend.own = vec![Found {
        kind: "note",
        key: "note:n1".into(),
        title: "Call with the installer".into(),
        url: None,
        note_id: Some("n1".into()),
        excerpt: Some("Quote received: 14 500 euros.".into()),
    }];
    backend.report = "# Heat pumps in old houses\n\n## Executive summary\n\nThey work in old houses [1] and cost 12 000 to 18 000 euros [3], close to the quote you received [4]. One study is cited twice [1, 3]. A made-up claim [9]. A link stays a link [docs](https://x.example).\n\n## What they cost\n\nSee [3-4].\n\n## References\n\n1. Something the model made up\n".into();
    backend
}

async fn approved_run(pool: &SqlitePool, depth: Depth, use_notes: bool) -> String {
    let id = "run-1";
    store::insert_run(
        pool,
        &store::NewRun {
            id,
            question: "Are heat pumps worth it in an old house?",
            depth,
            use_notes,
            project_id: None,
            chat_id: Some("chat-1"),
            model: "test-model",
        },
    )
    .await
    .unwrap();
    store::set_questions(pool, id, &["Which country?".into()])
        .await
        .unwrap();
    store::set_plan(pool, id, &["France".into()], &plan())
        .await
        .unwrap();
    store::approve(pool, id, depth, &clamp_plan(&plan(), depth).unwrap())
        .await
        .unwrap();
    id.to_string()
}

#[tokio::test]
async fn a_run_searches_reads_and_writes_a_note_with_sources_the_app_resolved() {
    let pool = pool().await;
    let id = approved_run(&pool, Depth::Standard, true).await;
    let backend = scripted();
    let changes = AtomicUsize::new(0);
    let changed = || {
        changes.fetch_add(1, Ordering::SeqCst);
    };
    engine::drive(&pool, &backend, &id, &StopSignal::default(), &changed)
        .await
        .unwrap();

    let run = store::run_row(&pool, &id).await.unwrap().unwrap();
    assert_eq!(run.status, "done");
    assert_eq!(run.report_note_id.as_deref(), Some("note-report"));
    // Every search ran once, in the plan's order.
    assert_eq!(
        *backend.searches.lock().unwrap(),
        vec![
            "heat pump old house efficiency",
            "heat pump cost retrofit",
            "heat pump subsidies"
        ]
    );
    let sources = store::sources(&pool, &id).await.unwrap();
    let statuses: Vec<(&str, &str)> = sources
        .iter()
        .map(|s| (s.title.as_str(), s.status.as_str()))
        .collect();
    assert_eq!(
        statuses,
        vec![
            ("Field study", "read"),
            ("Blocked page", "failed"),
            ("Cookie page", "skipped"),
            ("Price survey", "read"),
            ("Call with the installer", "read"),
        ]
    );
    // The report pass saw only what was read, numbered by the app.
    let prompt = backend.report_prompt.lock().unwrap().clone();
    assert!(prompt.contains("[1] Field study\n- Notes on Field study"));
    assert!(prompt.contains("[2] Price survey"));
    assert!(prompt.contains("[3] Call with the installer\nQuote received: 14 500 euros."));
    assert!(!prompt.contains("Cookie page"));
    assert!(prompt.contains("Which country?: France"));

    let saved = backend.saved.lock().unwrap().clone();
    assert_eq!(saved.len(), 1);
    let (title, body) = &saved[0];
    assert_eq!(title, "Heat pumps in old houses");
    assert!(!body.starts_with("# "));
    // Handed: 1 the study, 2 the prices, 3 the note. The report cites 1 and
    // 3 (renumbered 1 and 2) and invents 4 and 9.
    assert_eq!(run.invented_citations, 2);
    assert!(body.contains("A made-up claim."));
    assert!(body.contains("[docs](https://x.example)"));
    assert!(!body.contains("Something the model made up"));
    assert!(body.ends_with(
        "## Sources\n\n1. [Field study](https://a.example/study)\n2. Call with the installer · note"
    ));
    assert_eq!(run.cited_sources, 2);
    assert!(changes.load(Ordering::SeqCst) >= 8);
}

#[tokio::test]
async fn a_run_cut_off_midway_resumes_where_it_was_without_paying_twice() {
    let pool = pool().await;
    let id = approved_run(&pool, Depth::Quick, false).await;
    let first = scripted();
    // The first process does three steps (two searches and a third) and dies.
    for _ in 0..4 {
        let run = store::run_row(&pool, &id).await.unwrap().unwrap();
        assert_eq!(
            engine::advance(&pool, &first, &run).await.unwrap(),
            Advanced::Step
        );
    }
    assert_eq!(first.searches.lock().unwrap().len(), 3);
    assert_eq!(first.fetched.lock().unwrap().len(), 1);
    let run = store::run_row(&pool, &id).await.unwrap().unwrap();
    assert_eq!(run.status, "running");
    assert_eq!(run.phase.as_deref(), Some("reading"));

    // The next launch's sweep picks the row up with a fresh process.
    let second = scripted();
    engine::drive(&pool, &second, &id, &StopSignal::default(), &|| {})
        .await
        .unwrap();
    assert!(second.searches.lock().unwrap().is_empty());
    assert_eq!(
        *second.fetched.lock().unwrap(),
        vec![
            "https://b.example/blocked",
            "https://c.example/cookies",
            "https://d.example/prices"
        ]
    );
    let run = store::run_row(&pool, &id).await.unwrap().unwrap();
    assert_eq!(run.status, "done");
    assert_eq!(second.saved.lock().unwrap().len(), 1);
    assert!(store::unfinished(&pool).await.unwrap().is_empty());
}

#[tokio::test]
async fn stop_lands_mid_read_and_the_report_can_be_written_from_what_was_read() {
    let pool = pool().await;
    let id = approved_run(&pool, Depth::Standard, false).await;
    let mut backend = scripted();
    backend.hang_on = Some("https://d.example/prices".into());
    let backend = Arc::new(backend);
    let stop = Arc::new(StopSignal::default());
    let task = {
        let (pool, backend, stop, id) = (
            pool.clone(),
            Arc::clone(&backend),
            Arc::clone(&stop),
            id.clone(),
        );
        tokio::spawn(async move { engine::drive(&pool, &*backend, &id, &stop, &|| {}).await })
    };
    backend.hanging.notified().await;
    // What `research_stop` does: the row first, then the live signal.
    assert!(store::stop(&pool, &id).await.unwrap());
    stop.stop();
    task.await.unwrap().unwrap();
    let run = store::run_row(&pool, &id).await.unwrap().unwrap();
    assert_eq!(run.status, "stopped");
    assert!(backend.saved.lock().unwrap().is_empty());
    // The page that was being read is still waiting, not lost.
    let pending: Vec<String> = store::sources(&pool, &id)
        .await
        .unwrap()
        .into_iter()
        .filter(|s| s.status == "pending")
        .map(|s| s.title)
        .collect();
    assert_eq!(pending, vec!["Price survey"]);

    // "Write the report now".
    store::skip_remaining(&pool, &id).await.unwrap();
    store::set_status(&pool, &id, "running", None)
        .await
        .unwrap();
    let after = scripted();
    engine::drive(&pool, &after, &id, &StopSignal::default(), &|| {})
        .await
        .unwrap();
    let run = store::run_row(&pool, &id).await.unwrap().unwrap();
    assert_eq!(run.status, "done");
    assert!(after.fetched.lock().unwrap().is_empty());
    let prompt = after.report_prompt.lock().unwrap().clone();
    assert!(prompt.contains("[1] Field study") && !prompt.contains("Price survey"));
}

#[tokio::test]
async fn a_stop_before_the_next_step_stops_without_calling_anything() {
    let pool = pool().await;
    let id = approved_run(&pool, Depth::Quick, false).await;
    let backend = scripted();
    let stop = StopSignal::default();
    stop.stop();
    engine::drive(&pool, &backend, &id, &stop, &|| {})
        .await
        .unwrap();
    assert_eq!(
        store::run_row(&pool, &id).await.unwrap().unwrap().status,
        "stopped"
    );
    assert!(backend.searches.lock().unwrap().is_empty());
    assert_eq!(backend.completions.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_transport_failure_fails_the_run_and_nothing_readable_is_said_so() {
    let pool = pool().await;
    let id = approved_run(&pool, Depth::Quick, false).await;
    let mut offline = plan();
    offline.sections[0].queries = vec!["offline".into()];
    store::approve(&pool, &id, Depth::Quick, &offline)
        .await
        .unwrap();
    let error = engine::drive(&pool, &scripted(), &id, &StopSignal::default(), &|| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, "network");

    // Searches that find nothing readable end in words, not a blank note.
    let mut empty = plan();
    empty.sections = vec![PlanSection {
        title: "Nothing".into(),
        queries: vec!["no results here".into()],
    }];
    store::approve(&pool, &id, Depth::Quick, &empty)
        .await
        .unwrap();
    let error = engine::drive(&pool, &scripted(), &id, &StopSignal::default(), &|| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, "research_no_sources");
}

#[tokio::test]
async fn the_budget_caps_the_sources_a_depth_may_read() {
    let pool = pool().await;
    let id = approved_run(&pool, Depth::Quick, false).await;
    let mut backend = scripted();
    for query in [
        "heat pump old house efficiency",
        "heat pump cost retrofit",
        "heat pump subsidies",
    ] {
        backend.results.insert(
            query.into(),
            (0..12)
                .map(|n| {
                    web(
                        &format!("https://{query}.example/{n}").replace(' ', "-"),
                        "Page",
                    )
                })
                .collect(),
        );
    }
    let mut run = store::run_row(&pool, &id).await.unwrap().unwrap();
    while store::pending_step(&pool, &id).await.unwrap().is_some() {
        engine::advance(&pool, &backend, &run).await.unwrap();
        run = store::run_row(&pool, &id).await.unwrap().unwrap();
    }
    let sources = store::sources(&pool, &id).await.unwrap();
    // Quick reads ten at most, and the last search still found its share.
    assert_eq!(sources.len(), 10);
    assert!(sources
        .iter()
        .any(|s| s.url.as_deref().unwrap_or("").contains("subsidies")));
}

fn handed(index: usize, title: &str, url: Option<&str>, kind: &str) -> HandedSource {
    HandedSource {
        index,
        kind: kind.into(),
        title: title.into(),
        url: url.map(str::to_string),
    }
}

#[test]
fn citations_are_renumbered_in_order_of_mention_and_inventions_dropped() {
    let sources = vec![
        handed(1, "One", Some("https://one.example"), "web"),
        handed(2, "Two [draft]", Some("https://two.example/a b"), "web"),
        handed(3, "Plan", None, "project_file"),
    ];
    let assembled = report::assemble(
        "Title",
        "Opening claim [2]. Then [1][2]. Range [1-3]. Bad [7]. Mixed [3, 8].\n\n### Sources:\n- junk",
        &sources,
    );
    assert_eq!(assembled.invented, vec![7, 8]);
    assert_eq!(
        assembled.markdown,
        "# Title\n\nOpening claim [1]. Then [2][1]. Range [2][1][3]. Bad. Mixed [3].\n\n## Sources\n\n1. [Two (draft)](https://two.example/a%20b)\n2. [One](https://one.example)\n3. Plan · document\n"
    );
    // Nothing cited, nothing listed; brackets that are not numbers stay.
    let plain = report::assemble("T", "# Own title\n\nText [a] and [ ] stay.", &sources);
    assert_eq!(plain.markdown, "# Own title\n\nText [a] and [ ] stay.\n");
    assert_eq!(report::report_title(&plain.markdown, "T"), "Own title");
    assert_eq!(
        report::without_title(&plain.markdown),
        "Text [a] and [ ] stay."
    );
}

#[test]
fn the_plan_is_read_from_whatever_the_model_wrapped_it_in_and_clamped() {
    let reply = "Here is the plan:\n```json\n{\"title\":\"Pumps\",\"sections\":[{\"title\":\"Cost\",\"queries\":[\"a\",\"b\",\"c\",\"d\"]},{\"title\":\"\",\"queries\":[\"e\"]},{\"title\":\"Empty\",\"queries\":[]}]}\n```";
    let plan = prompts::parse_plan(reply, "Are pumps worth it?");
    assert_eq!(plan.title, "Pumps");
    // Three searches per section at most; a section without a title or
    // without searches is not a section.
    assert_eq!(plan.sections.len(), 1);
    assert_eq!(plan.sections[0].queries, vec!["a", "b", "c"]);
    let fallback = prompts::parse_plan("I cannot", "Are pumps worth it?");
    assert_eq!(fallback.sections[0].queries, vec!["Are pumps worth it?"]);

    let mut long = plan.clone();
    long.sections.push(PlanSection {
        title: " ".into(),
        queries: vec!["  x   y ".into(), "".into(), "z".into()],
    });
    let clamped = clamp_plan(&long, Depth::Quick).unwrap();
    assert_eq!(clamped.sections.len(), 2);
    assert_eq!(clamped.sections[1].title, "x y");
    assert_eq!(clamped.sections[1].queries, vec!["x y"]);
    let total: usize = clamped.sections.iter().map(|s| s.queries.len()).sum();
    assert_eq!(total, Depth::Quick.max_queries());
    let empty = ResearchPlan {
        title: "t".into(),
        sections: vec![PlanSection {
            title: "s".into(),
            queries: vec![" ".into()],
        }],
    };
    assert!(clamp_plan(&empty, Depth::Deep).is_err());
}

#[test]
fn clarifying_questions_are_three_at_most_and_none_is_an_answer() {
    assert_eq!(
        prompts::parse_questions("{\"questions\":[\"Where?\",\"When?\",\"Why?\",\"Who?\"]}"),
        vec!["Where?", "When?", "Why?"]
    );
    assert!(prompts::parse_questions("{\"questions\":[]}").is_empty());
    assert!(prompts::parse_questions("No questions.").is_empty());
    assert!(prompts::is_irrelevant("IRRELEVANT."));
    assert!(!prompts::is_irrelevant(
        "- Irrelevant to most, but COP is 3.1 in old houses"
    ));
}

#[test]
fn the_estimate_grows_with_depth_and_counts_one_note_per_page_and_the_report() {
    let quick = estimate(Depth::Quick, 4);
    let deep = estimate(Depth::Deep, 14);
    assert_eq!(
        (quick.searches, quick.page_reads, quick.model_calls),
        (4, 10, 11)
    );
    assert_eq!((deep.page_reads, deep.model_calls), (50, 51));
    assert!(deep.prompt_tokens > quick.prompt_tokens * 4);
    assert!(quick.completion_tokens >= u64::from(prompts::REPORT_MAX_TOKENS));
    assert_eq!(Depth::Standard.own_sources(), 5);
}

#[test]
fn web_results_keep_only_pages_the_app_can_open() {
    let body = serde_json::json!({ "data": { "results": [
        { "title": "A", "url": "https://a.example/x/#top", "snippet": "s" },
        { "title": "", "url": "http://b.example" },
        { "title": "C", "url": "javascript:alert(1)" },
        { "title": "D" }
    ]}});
    let found = backend::web_results(body.to_string().as_bytes());
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].key, "https://a.example/x");
    assert_eq!(found[1].title, "http://b.example");
    assert!(backend::web_results(b"not json").is_empty());
}
