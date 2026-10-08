//! What both agents are taught about chart and table cards (ADR-0024 for the
//! envelope, ADR-0086 for these two kinds), and how each of them gets the
//! numbers: the desktop through Hermes' own Python, the phones through
//! `run_python`. One text for the card shapes, so the desktop soul and the
//! phone prompt cannot drift from each other or from the parser in
//! `src/lib/chat-blocks-data.ts`, which ships in the same build.

pub const CARDS_PROMPT: &str = r#"Chart and table cards: when an answer rests on numbers worth seeing (a comparison, a trend, a breakdown, a distribution), you may embed one fenced code block whose info string is subrosa:chart, and for rows worth reading or sorting one whose info string is subrosa:table. The app draws them with tooltips, a data view and downloads, in both themes.
A subrosa:chart body is one JSON object: {"v":1,"type":"bar","title":"…","x":{"title":"…"},"y":{"title":"…","unit":"€"},"categories":["Q1","Q2","Q3"],"series":[{"name":"2025","values":[120,135,null]}],"stacked":false,"source":"…"}. type is bar (compare categories; "stacked":true for the parts of a whole), line or area (change over ordered categories such as dates), pie or donut (the parts of one total: one series, eight slices at most), or scatter (two measures against each other, where each series is {"name":"…","points":[[x,y],…]} and "x" takes its own "unit"). One value per category, null for a gap, numbers as JSON numbers. At most eight series (three for scatter), one y axis: two measures of different scale are two charts. Units go in "unit", never inside the numbers.
A subrosa:table body: {"v":1,"title":"…","columns":["Region",{"label":"Revenue","unit":"€"}],"rows":[["North",1200],["South",900]],"source":"…"}. Numbers as JSON numbers so they sort and align, 500 rows at most.
Chart only numbers you actually have, from the user's files or notes, a tool result or a computation; never invented or estimated figures. Say in your prose what the chart shows, and do not add a table of the same numbers under a chart: the chart has its own data view."#;

pub const PHONE_ANALYSIS_PROMPT: &str = "Data analysis: run_python runs Python on the phone with numpy and pandas (no other packages, no network). Use it whenever the answer needs a computation over data, such as totals, averages, grouping, statistics, or reading an attached CSV or spreadsheet, rather than doing arithmetic in your head. Files attached to this message are in /data, a spreadsheet as one CSV per sheet. In the code, subrosa_chart(\"bar\", data=df, x=\"column\", y=[\"column\"], title=\"…\", unit=\"…\") and subrosa_table(df, title=\"…\") make cards: the tool result returns each card's fenced block, which you copy verbatim into your answer. If the tool says the analysis needs the app open, tell the user to keep Sub Rosa on screen and ask again.";

pub const DESKTOP_ANALYSIS_PROMPT: &str = "Data analysis: when the user attaches a CSV, a spreadsheet or another data file, or asks something that needs a computation, analyse it with Python through your code execution tool (pandas and numpy) instead of estimating. Present what you computed as `subrosa:table` and `subrosa:chart` blocks in your reply, built from the computed numbers, rather than as a matplotlib image: the app draws them interactively in both themes and lets the user save them as PNG, SVG or CSV. When the user wants a file (a cleaned CSV, a workbook), write it into the session's working folder, or your workspace when there is none, and give its path: files you write appear in the chat as artifacts.";

/// The desktop soul's section, appended after the other card kinds.
pub fn desktop_soul_section() -> String {
    format!("\n{CARDS_PROMPT}\n\n{DESKTOP_ANALYSIS_PROMPT}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The example in the prompt is the shape the parser accepts: a model
    /// copying it must get a card, not a code block.
    #[test]
    fn the_prompt_examples_are_valid_json_with_a_version() {
        for marker in [
            "{\"v\":1,\"type\":\"bar\"",
            "{\"v\":1,\"title\":\"…\",\"columns\"",
        ] {
            let start = CARDS_PROMPT.find(marker).expect("example present");
            let mut depth = 0usize;
            let mut end = start;
            for (offset, character) in CARDS_PROMPT[start..].char_indices() {
                match character {
                    '{' | '[' => depth += 1,
                    '}' | ']' => {
                        depth -= 1;
                        if depth == 0 {
                            end = start + offset + character.len_utf8();
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let value: serde_json::Value =
                serde_json::from_str(&CARDS_PROMPT[start..end]).expect("example parses");
            assert_eq!(value["v"], 1);
        }
    }

    #[test]
    fn the_desktop_section_points_at_code_execution_and_both_cards() {
        let section = desktop_soul_section();
        assert!(section.contains("subrosa:chart"));
        assert!(section.contains("subrosa:table"));
        assert!(section.contains("code execution"));
        assert!(!section.contains("run_python"));
    }
}
