//! The phone checks of ADR-0086, runnable on a simulator or a device.
//!
//! Debug builds only. Launched with `SUBROSA_PYTHON_SELFTEST=1` (on the iOS
//! simulator: `SIMCTL_CHILD_SUBROSA_PYTHON_SELFTEST=1 xcrun simctl launch
//! booted xyz.carpediem.subrosa`), the app runs a fixed set of analyses
//! through the real `run_python` path once the webview's bridge answers: the
//! event, the module worker, Pyodide and its wheels served by the app's own
//! scheme under the app's CSP, the reply command. Each case is timed on the
//! Rust clock, so the first one is Pyodide's cold start and the first pandas
//! one is the wheels' load. The report goes to the log and to
//! `python-selftest.json` in the app's data folder, which `xcrun simctl
//! get_app_container booted xyz.carpediem.subrosa data` locates. No model and
//! no key are involved: this checks the runtime, not the prompts.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::{
    run, Outcome, PythonFile, PythonOutcome, PythonRunEvent, PYTHON_CANCEL_EVENT, PYTHON_RUN_EVENT,
};

pub const ENV: &str = "SUBROSA_PYTHON_SELFTEST";
pub const REPORT_FILE: &str = "python-selftest.json";
const SESSION: &str = "python-selftest";
/// The tool's own first-answer clock, and a run limit loose enough to time a
/// slow cold start rather than cut it.
const CLOCKS: (Duration, Duration) = (Duration::from_secs(5), Duration::from_secs(300));
/// The bridge mounts with the phone shell, some seconds after launch.
const BRIDGE_ATTEMPTS: u32 = 30;
const BRIDGE_RETRY: Duration = Duration::from_secs(1);
const MAX_DETAIL_CHARS: usize = 600;

const SALES_CSV: &str = "region,month,amount\nNorth,Jan,120\nNorth,Feb,340\nSouth,Jan,410\nSouth,Feb,290\nEast,Jan,500\nEast,Feb,220\n";
/// The document reader's listing of a spreadsheet, as a phone turn holds it.
const BUDGET_LISTING: &str =
    "[Sheet 1]\nA1: Item\nB1: Cost\nA2: Rent\nB2: 1200\nA3: Food\nB3: 450\n";

const PANDAS_CODE: &str = r#"import numpy as np
import pandas as pd
df = pd.read_csv("/data/sales.csv")
total = int(df["amount"].sum())
by_region = df.groupby("region", as_index=False)["amount"].sum()
print("total", total, "mean", float(np.round(df["amount"].mean(), 2)))
subrosa_chart("bar", data=by_region, x="region", y=["amount"], title="Sales by region", unit="CHF")"#;

/// The page's policy, inherited by the worker (worker-url.ts), allows no
/// `eval` and no host but the app's own and loopback. Both are tried; a worker
/// that escaped the policy would answer "allowed" or "reached".
const CSP_CODE: &str = r#"import asyncio
import js
try:
    js.eval("1 + 1")
    evaluated = "eval allowed"
except Exception:
    evaluated = "eval refused"
try:
    await asyncio.wait_for(js.fetch("https://example.com/"), 10)
    fetched = "network reached"
except asyncio.TimeoutError:
    fetched = "network silent"
except Exception as error:
    fetched = "network refused (" + type(error).__name__ + ": " + str(error)[:120] + ")"
evaluated + ", " + fetched"#;

type Expect = fn(&PythonOutcome) -> Result<(), String>;

struct Case {
    name: &'static str,
    code: &'static str,
    files: &'static [(&'static str, &'static str)],
    expect: Expect,
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "cold start",
            code: "import sys\nsys.version",
            files: &[],
            expect: |done| contains(done.result.as_deref(), "3.13"),
        },
        Case {
            name: "numpy",
            code: "import numpy as np\na = np.arange(1, 1001)\nprint(int(a.sum()), float(a.mean()))",
            files: &[],
            expect: |done| contains(Some(&done.stdout), "500500 500.5"),
        },
        Case {
            name: "pandas over a mounted CSV, first load",
            code: PANDAS_CODE,
            files: &[("sales.csv", SALES_CSV)],
            expect: expect_sales,
        },
        Case {
            name: "pandas over a mounted CSV, warm",
            code: PANDAS_CODE,
            files: &[("sales.csv", SALES_CSV)],
            expect: expect_sales,
        },
        Case {
            name: "variables persist in the conversation",
            code: "total * 2",
            files: &[],
            expect: |done| contains(done.result.as_deref(), "3760"),
        },
        Case {
            name: "a spreadsheet becomes one CSV per sheet",
            code: "import pandas as pd\nbudget = pd.read_csv(\"/data/budget.sheet1.csv\")\nsubrosa_table(budget, title=\"Budget\")\nint(budget[\"Cost\"].sum())",
            files: &[("budget.xlsx", BUDGET_LISTING)],
            expect: |done| {
                contains(Some(&done.files.join(",")), "/data/budget.sheet1.csv")?;
                contains(done.result.as_deref(), "1650")?;
                let table = block(done, "table")?;
                if table["rows"].as_array().map(Vec::len) != Some(2) {
                    return Err(format!("expected two table rows: {table}"));
                }
                Ok(())
            },
        },
        Case {
            name: "the worker runs under the app's CSP",
            code: CSP_CODE,
            files: &[],
            expect: |done| contains(done.result.as_deref(), "eval refused, network refused"),
        },
        Case {
            name: "an exception reaches the model as a traceback",
            code: "1 / 0",
            files: &[],
            expect: |done| contains(done.error.as_deref(), "ZeroDivisionError"),
        },
    ]
}

fn expect_sales(done: &PythonOutcome) -> Result<(), String> {
    if done.files != ["/data/sales.csv"] {
        return Err(format!("mounted {:?}", done.files));
    }
    contains(Some(&done.stdout), "total 1880 mean 313.33")?;
    let chart = block(done, "chart")?;
    if chart["type"] != "bar"
        || chart["categories"] != serde_json::json!(["East", "North", "South"])
    {
        return Err(format!("unexpected chart {chart}"));
    }
    if chart["series"][0]["values"] != serde_json::json!([720, 460, 700]) {
        return Err(format!("unexpected values {chart}"));
    }
    Ok(())
}

fn contains(text: Option<&str>, needle: &str) -> Result<(), String> {
    match text {
        Some(text) if text.contains(needle) => Ok(()),
        _ => Err(format!("expected {needle:?}")),
    }
}

fn block(done: &PythonOutcome, kind: &str) -> Result<serde_json::Value, String> {
    let found = done
        .blocks
        .iter()
        .find(|block| block.kind == kind)
        .ok_or_else(|| format!("no {kind} block"))?;
    serde_json::from_str(&found.json).map_err(|error| format!("{kind} block: {error}"))
}

#[derive(Debug, Serialize)]
pub struct CaseReport {
    pub name: String,
    pub passed: bool,
    pub millis: u128,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub passed: bool,
    pub cases: Vec<CaseReport>,
}

fn summary(done: &PythonOutcome) -> String {
    let mut parts = Vec::new();
    if !done.stdout.trim().is_empty() {
        parts.push(format!("stdout: {}", done.stdout.trim()));
    }
    if let Some(result) = &done.result {
        parts.push(format!("result: {result}"));
    }
    if let Some(error) = &done.error {
        parts.push(format!("error: {error}"));
    }
    parts.push(format!("blocks: {}", done.blocks.len()));
    let text = parts.join(" | ");
    text.chars().take(MAX_DETAIL_CHARS).collect()
}

fn verdict(expect: Expect, outcome: Outcome) -> (bool, String) {
    match outcome {
        Outcome::Done(done) => match expect(&done) {
            Ok(()) => (true, summary(&done)),
            Err(why) => (false, format!("{why}; {}", summary(&done))),
        },
        other => (false, format!("{other:?}")),
    }
}

/// Every case in order, in one conversation. Only the first waits for the
/// bridge; a later case the app does not answer fails as it would in a turn.
async fn run_all(
    emit: impl Fn(&PythonRunEvent) -> bool,
    cancel: impl Fn(&str),
    (attempts, retry): (u32, Duration),
    clocks: (Duration, Duration),
) -> Report {
    let mut reports = Vec::new();
    for (index, case) in cases().into_iter().enumerate() {
        let tries = if index == 0 { attempts.max(1) } else { 1 };
        let mut outcome = Outcome::NeedsApp;
        let mut millis = 0;
        for attempt in 0..tries {
            if attempt > 0 {
                tokio::time::sleep(retry).await;
            }
            let request = PythonRunEvent {
                request_id: uuid::Uuid::new_v4().to_string(),
                session: SESSION.to_string(),
                code: case.code.to_string(),
                files: case
                    .files
                    .iter()
                    .map(|(name, text)| PythonFile {
                        name: (*name).to_string(),
                        text: (*text).to_string(),
                    })
                    .collect(),
            };
            let started = Instant::now();
            outcome = run(request, clocks, &emit, &cancel).await;
            millis = started.elapsed().as_millis();
            if outcome != Outcome::NeedsApp {
                break;
            }
        }
        let (passed, detail) = verdict(case.expect, outcome);
        tracing::info!(case = case.name, passed, millis, %detail, "python self-test");
        reports.push(CaseReport {
            name: case.name.to_string(),
            passed,
            millis,
            detail,
        });
    }
    Report {
        passed: reports.iter().all(|report| report.passed),
        cases: reports,
    }
}

/// Starts the checks when the environment asks for them; a no-op otherwise.
pub fn spawn_if_requested(app: &AppHandle) {
    if std::env::var(ENV).ok().as_deref() != Some("1") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let report = run_all(
            |event| app.emit(PYTHON_RUN_EVENT, event).is_ok(),
            |id| {
                let _ = app.emit(PYTHON_CANCEL_EVENT, serde_json::json!({ "requestId": id }));
            },
            (BRIDGE_ATTEMPTS, BRIDGE_RETRY),
            CLOCKS,
        )
        .await;
        tracing::info!(passed = report.passed, "python self-test finished");
        let written = app.path().app_data_dir().map(|dir| dir.join(REPORT_FILE));
        match (written, serde_json::to_vec_pretty(&report)) {
            (Ok(path), Ok(bytes)) => {
                let saved = path
                    .parent()
                    .map(std::fs::create_dir_all)
                    .transpose()
                    .and_then(|_| std::fs::write(&path, bytes));
                if let Err(error) = saved {
                    tracing::warn!(%error, "python self-test report not written");
                }
            }
            _ => tracing::warn!("python self-test report not written"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::super::{deliver, PythonBlock, PythonReply};
    use super::*;

    const QUICK: (Duration, Duration) = (Duration::from_millis(200), Duration::from_millis(300));

    fn sales_outcome() -> PythonOutcome {
        PythonOutcome {
            stdout: "total 1880 mean 313.33\n".to_string(),
            blocks: vec![PythonBlock {
                kind: "chart".to_string(),
                json: r#"{"v":1,"type":"bar","categories":["East","North","South"],"series":[{"name":"amount","values":[720,460,700]}]}"#.to_string(),
            }],
            files: vec!["/data/sales.csv".to_string()],
            ..PythonOutcome::default()
        }
    }

    #[test]
    fn the_sales_case_accepts_the_right_chart_only() {
        assert_eq!(expect_sales(&sales_outcome()), Ok(()));
        let mut wrong = sales_outcome();
        wrong.blocks[0].json = wrong.blocks[0].json.replace("720", "721");
        assert!(expect_sales(&wrong).is_err());
        let mut unmounted = sales_outcome();
        unmounted.files.clear();
        assert!(expect_sales(&unmounted).is_err());
    }

    #[test]
    fn a_run_that_never_finished_is_a_failure_that_says_why() {
        let (passed, detail) = verdict(expect_sales, Outcome::TimedOut);
        assert!(!passed);
        assert_eq!(detail, "TimedOut");
    }

    #[tokio::test]
    async fn without_a_bridge_every_case_fails_after_the_retries() {
        let emitted = std::sync::atomic::AtomicUsize::new(0);
        let report = run_all(
            |_| {
                emitted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                true
            },
            |_| {},
            (3, Duration::from_millis(1)),
            QUICK,
        )
        .await;
        assert!(!report.passed);
        assert_eq!(report.cases.len(), cases().len());
        // Three tries for the first case, one for each of the others.
        assert_eq!(
            emitted.load(std::sync::atomic::Ordering::SeqCst),
            3 + cases().len() - 1
        );
    }

    #[tokio::test]
    async fn the_report_follows_what_the_webview_answers() {
        let report = run_all(
            |event: &PythonRunEvent| {
                let id = event.request_id.clone();
                let done = match event.code.as_str() {
                    "import sys\nsys.version" => PythonOutcome {
                        result: Some("'3.13.2 (main)'".to_string()),
                        ..PythonOutcome::default()
                    },
                    PANDAS_CODE => sales_outcome(),
                    _ => PythonOutcome::default(),
                };
                tokio::spawn(async move {
                    deliver(&id, PythonReply::Started);
                    deliver(&id, PythonReply::Done(done));
                });
                true
            },
            |_| {},
            (1, Duration::from_millis(1)),
            QUICK,
        )
        .await;
        let passed: Vec<bool> = report.cases.iter().map(|case| case.passed).collect();
        assert_eq!(
            passed,
            [true, false, true, true, false, false, false, false]
        );
        assert!(!report.passed);
    }
}
