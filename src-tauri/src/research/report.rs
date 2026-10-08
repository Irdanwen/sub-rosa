//! The report the model wrote, made into the note the app keeps.
//!
//! The model numbers; the app resolves (ADR-0044). The report pass was handed
//! numbered source notes and cited them as `[n]`. Here every citation is
//! checked against the list that was handed out: a number that names a
//! source is renumbered in order of first mention, so the report reads [1],
//! [2], [3] whatever the sources' order was; a number that names nothing is
//! removed and counted, and the run says how many. The sources list at the
//! end is written by the app from its own rows, never by the model, so every
//! link in it is an address the app actually read.

/// A source the report pass was handed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandedSource {
    /// The number the model was shown.
    pub index: usize,
    pub kind: String,
    pub title: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assembled {
    pub markdown: String,
    /// The sources the report cites, in their new order.
    pub cited: Vec<HandedSource>,
    /// Numbers the model cited that named no source it was handed.
    pub invented: Vec<usize>,
}

/// Headings a model writes over a references list it was told not to write.
const SOURCE_HEADINGS: &[&str] = &[
    "sources",
    "source",
    "references",
    "référence",
    "références",
    "bibliography",
    "bibliographie",
    "works cited",
    "citations",
];

/// The report up to a sources section of its own, if the model wrote one.
fn without_model_sources(markdown: &str) -> &str {
    let mut offset = 0;
    for line in markdown.split_inclusive('\n') {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let heading = trimmed
                .trim_start_matches('#')
                .trim()
                .trim_end_matches(':')
                .trim()
                .to_lowercase();
            if SOURCE_HEADINGS.contains(&heading.as_str()) {
                return &markdown[..offset];
            }
        }
        offset += line.len();
    }
    markdown
}

/// The numbers in a citation's brackets: `1`, `1, 3`, `2-4`. None when the
/// brackets hold anything else, so `[note]` or `[x]` stay text.
fn citation_numbers(inner: &str) -> Option<Vec<usize>> {
    let mut numbers = Vec::new();
    for part in inner.split([',', ';']) {
        let part = part.trim();
        if part.is_empty() {
            return None;
        }
        if let Some((from, to)) = part.split_once(['-', '\u{2013}']) {
            let (from, to) = (
                from.trim().parse::<usize>().ok()?,
                to.trim().parse::<usize>().ok()?,
            );
            if to < from || to - from > 20 {
                return None;
            }
            numbers.extend(from..=to);
        } else {
            numbers.push(part.parse::<usize>().ok()?);
        }
    }
    (!numbers.is_empty()).then_some(numbers)
}

/// Rewrites every citation in `text` through `resolve`, which answers the
/// new number for a handed-out one and None for an invented one.
fn rewrite_citations(text: &str, mut resolve: impl FnMut(usize) -> Option<usize>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find(']') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let inner = &after[..close];
        let tail = &after[close + 1..];
        // `[text](url)` is a link, not a citation.
        match citation_numbers(inner).filter(|_| !tail.starts_with('(')) {
            Some(numbers) => {
                let mut kept: Vec<usize> = Vec::new();
                for number in numbers {
                    if let Some(new) = resolve(number) {
                        if !kept.contains(&new) {
                            kept.push(new);
                        }
                    }
                }
                if kept.is_empty() {
                    // Nothing left to cite: drop the brackets and the space
                    // that led to them.
                    while out.ends_with(' ') {
                        out.pop();
                    }
                } else {
                    for number in kept {
                        out.push_str(&format!("[{number}]"));
                    }
                }
            }
            None => {
                out.push('[');
                out.push_str(inner);
                out.push(']');
            }
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

/// `[` and `]` in a title would end the link early.
fn link_label(title: &str) -> String {
    title.replace('[', "(").replace(']', ")").trim().to_string()
}

fn source_line(number: usize, source: &HandedSource) -> String {
    let title = link_label(&source.title);
    match (&source.url, source.kind.as_str()) {
        (Some(url), _) => format!("{number}. [{title}]({})", url.replace(' ', "%20")),
        (None, "note") => format!("{number}. {title} · note"),
        (None, _) => format!("{number}. {title} · document"),
    }
}

/// The note's text: the report with its citations resolved and the sources
/// list the app writes.
pub fn assemble(title: &str, raw: &str, handed: &[HandedSource]) -> Assembled {
    let body = without_model_sources(raw).trim();
    let mut order: Vec<usize> = Vec::new();
    let mut invented: Vec<usize> = Vec::new();
    let rewritten = rewrite_citations(body, |number| {
        if handed.iter().any(|source| source.index == number) {
            let position = match order.iter().position(|seen| *seen == number) {
                Some(position) => position,
                None => {
                    order.push(number);
                    order.len() - 1
                }
            };
            Some(position + 1)
        } else {
            if !invented.contains(&number) {
                invented.push(number);
            }
            None
        }
    });
    let mut markdown = String::new();
    if !rewritten.trim_start().starts_with("# ") {
        markdown.push_str(&format!("# {}\n\n", title.trim()));
    }
    markdown.push_str(rewritten.trim());
    let cited: Vec<HandedSource> = order
        .iter()
        .filter_map(|number| handed.iter().find(|source| source.index == *number))
        .cloned()
        .collect();
    if !cited.is_empty() {
        markdown.push_str("\n\n## Sources\n\n");
        let lines: Vec<String> = cited
            .iter()
            .enumerate()
            .map(|(position, source)| source_line(position + 1, source))
            .collect();
        markdown.push_str(&lines.join("\n"));
    }
    markdown.push('\n');
    Assembled {
        markdown,
        cited,
        invented,
    }
}

/// The title the note is saved under: the report's own heading when it has
/// one, the plan's otherwise.
pub fn report_title(markdown: &str, fallback: &str) -> String {
    markdown
        .lines()
        .find_map(|line| line.trim().strip_prefix("# "))
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(fallback.trim())
        .to_string()
}

/// The report without its opening heading, which becomes the note's title.
pub fn without_title(markdown: &str) -> String {
    let trimmed = markdown.trim_start();
    match trimmed.strip_prefix("# ") {
        Some(rest) => rest
            .split_once('\n')
            .map(|(_, body)| body.trim().to_string())
            .unwrap_or_default(),
        None => trimmed.trim().to_string(),
    }
}
