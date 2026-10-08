//! The web client's data analysis (ADR-0086 on the web): `run_python`
//! declared for a browser, the card prompt, and what the tool answers the
//! model in each outcome.
//!
//! The phone's words say "phone" and "attached files in /data"; a browser has
//! neither, so the web's wording lives here, beside the phone's, rather than in
//! TypeScript. The limits are the phone's own.

use serde_json::{json, Value};

use crate::agent_lite::python;

const WEB_DESCRIPTION: &str = "Run Python 3 in the user's web browser, with numpy and pandas and the standard library (no other packages, no network, no files). Use it for any computation over data the conversation holds: totals, averages, grouping, pivots, statistics; put the data in the code itself. Returns print() output and the value of the last line. subrosa_chart(type, data=df, x=\"col\", y=[\"col\"], title=..., unit=...) and subrosa_table(df, title=...) turn a result into a card whose fenced block the result returns. Variables persist between runs in this conversation while the page stays open; if a name is gone, rebuild it.";

const WEB_ANALYSIS_PROMPT: &str = "Data analysis: run_python runs Python in this browser with numpy and pandas (no other packages, no network, no files). Use it whenever the answer needs a computation over data, such as totals, averages, grouping or statistics, rather than doing arithmetic in your head; write the data into the code. In the code, subrosa_chart(\"bar\", data=df, x=\"column\", y=[\"column\"], title=\"…\", unit=\"…\") and subrosa_table(df, title=\"…\") make cards: the tool result returns each card's fenced block, which you copy verbatim into your answer. If the tool says the analysis needs the page open, tell the user to keep this tab in front and ask again.";

const NEEDS_PAGE_OPEN: &str = "Analysis needs the page open: Python runs in this browser only while the Sub Rosa tab is in front, and it is not right now. Do not retry in this turn. Answer from what you have, and tell the user to keep the tab open and ask again for the computed result.";

fn definition() -> Value {
    let mut definition = python::definition();
    definition["function"]["description"] = json!(WEB_DESCRIPTION);
    let parameters = &mut definition["function"]["parameters"];
    if let Some(properties) = parameters["properties"].as_object_mut() {
        properties.remove("files");
    }
    definition
}

fn export() -> Value {
    json!({
        "generatedBy": "src-tauri/src/agent_lite/web_features/analysis.rs",
        "tool": definition(),
        "prompt": format!("{}\n\n{WEB_ANALYSIS_PROMPT}", crate::data_cards::CARDS_PROMPT),
        "limits": {
            "firstAnswerMs": python::FIRST_ANSWER.as_millis() as u64,
            "runLimitMs": python::RUN_LIMIT.as_millis() as u64,
            "maxCodeChars": python::MAX_CODE_CHARS,
            "maxBlocks": python::MAX_BLOCKS,
            "maxBlockChars": python::MAX_BLOCK_CHARS,
            "maxStdoutChars": python::MAX_STDOUT_CHARS,
        },
        "messages": {
            "needsPageOpen": NEEDS_PAGE_OPEN,
            "unavailable": "Python is not available in this browser right now{detail}. Answer without running code, and say the figures were not computed.",
            "timedOut": format!(
                "The analysis was stopped after {} seconds. Try a smaller computation, or work on part of the data.",
                python::RUN_LIMIT.as_secs()
            ),
            "stopped": "The user stopped the reply.",
            "noCode": "run_python needs Python code in `code`.",
            "tooLong": format!(
                "The code is too long to run ({} characters at most). Split it into smaller runs; variables persist between them.",
                python::MAX_CODE_CHARS
            ),
            "printedNothing": "The code ran and printed nothing. End it with an expression, or print() what you need.",
            "cards": "Cards (copy each block verbatim into your answer where it belongs):",
            "noNetwork": "No network: Python in this browser reaches nothing outside the code it is given.",
        },
    })
}

#[test]
fn the_web_client_reads_what_rust_says() {
    super::written("analysis", export());
}
