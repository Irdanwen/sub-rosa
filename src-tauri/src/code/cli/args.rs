//! `subrosa-code` arguments. Hand-parsed: one subcommand and a dozen flags do
//! not justify a parser crate in the app's dependency tree.

use std::path::PathBuf;

use crate::code::event::{ApprovalDecision, RunMode};

/// The most a run budget may be, in dollars: a typo (`--budget 200` for 2.00)
/// should fail loudly rather than spend.
pub const MAX_BUDGET_USD: f64 = 100.0;

pub const USAGE: &str = "\
Usage: subrosa-code run --dir <folder> --model <id> --budget <usd> [options]
       subrosa-code run --resume <run_id> [options]

Runs Sub Rosa's agent on a folder without a window and writes its events as
JSON lines on stdout (docs/code-cli.md).

Options:
  --dir <folder>        The folder the run works in.
  --model <id>          A Carpe Diem model id, for example kimi-k2-7-code.
  --mode build|plan     build may change the folder (default); plan reads it
                        and answers with a plan, the folder stays read-only.
  --budget <usd>        The run budget in dollars. The run stops cleanly once
                        what it spent reaches it. Required for a new run.
  --resume <run_id>     Continue a run with a new turn, on the same session.
  --prompt <text>       What to do.
  --prompt-file <path>  Read what to do from a file, or from stdin with -.
  --data-dir <folder>   The app's data folder (default: this build's).
  --approvals deny|once What a command the runtime flags gets when no one
                        is there to answer (default: deny).
  -h, --help            Show this help.
  -V, --version         Show the version.
";

#[derive(Clone, Debug, PartialEq)]
pub enum Invocation {
    Run(RunArgs),
    Help,
    Version,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PromptSource {
    Text(String),
    File(PathBuf),
    Stdin,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunArgs {
    pub dir: Option<PathBuf>,
    pub model: Option<String>,
    pub mode: Option<RunMode>,
    pub budget_usd: Option<f64>,
    pub resume: Option<String>,
    pub prompt: PromptSource,
    pub data_dir: Option<PathBuf>,
    /// `Once` or `Deny`.
    pub approvals: ApprovalDecision,
}

/// Parses everything after the program name.
pub fn parse<I, S>(args: I) -> Result<Invocation, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = args.into_iter().map(Into::into).peekable();
    match args.next().as_deref() {
        None | Some("-h" | "--help" | "help") => return Ok(Invocation::Help),
        Some("-V" | "--version") => return Ok(Invocation::Version),
        Some("run") => {}
        Some(other) => {
            return Err(format!(
                "Unknown command `{other}`. Try `subrosa-code --help`."
            ))
        }
    }

    let mut dir = None;
    let mut model = None;
    let mut mode = None;
    let mut budget_usd = None;
    let mut resume = None;
    let mut prompt = None;
    let mut data_dir = None;
    let mut approvals = ApprovalDecision::Deny;

    while let Some(flag) = args.next() {
        if matches!(flag.as_str(), "-h" | "--help") {
            return Ok(Invocation::Help);
        }
        let (name, inline) = match flag.split_once('=') {
            Some((name, value)) if name.starts_with("--") => {
                (name.to_string(), Some(value.to_string()))
            }
            _ => (flag.clone(), None),
        };
        let mut value = || -> Result<String, String> {
            inline
                .clone()
                .or_else(|| args.next())
                .ok_or_else(|| format!("`{name}` needs a value."))
        };
        match name.as_str() {
            "--dir" => set_once(&mut dir, PathBuf::from(value()?), &name)?,
            "--model" => {
                let id = value()?.trim().to_string();
                if id.is_empty() || id.chars().any(char::is_whitespace) {
                    return Err("`--model` takes a model id, for example kimi-k2-7-code.".into());
                }
                set_once(&mut model, id, &name)?;
            }
            "--mode" => {
                let parsed = match value()?.as_str() {
                    "build" => RunMode::Build,
                    "plan" => RunMode::Plan,
                    other => return Err(format!("`--mode` is build or plan, not `{other}`.")),
                };
                set_once(&mut mode, parsed, &name)?;
            }
            "--budget" => set_once(&mut budget_usd, parse_budget(&value()?)?, &name)?,
            "--resume" => set_once(&mut resume, parse_run_id(&value()?)?, &name)?,
            "--prompt" => {
                let text = value()?;
                if text.trim().is_empty() {
                    return Err("`--prompt` is empty.".into());
                }
                set_once(
                    &mut prompt,
                    PromptSource::Text(text),
                    "--prompt or --prompt-file",
                )?;
            }
            "--prompt-file" => {
                let path = value()?;
                let source = if path == "-" {
                    PromptSource::Stdin
                } else {
                    PromptSource::File(PathBuf::from(path))
                };
                set_once(&mut prompt, source, "--prompt or --prompt-file")?;
            }
            "--data-dir" => set_once(&mut data_dir, PathBuf::from(value()?), &name)?,
            "--approvals" => {
                approvals = match value()?.as_str() {
                    "deny" => ApprovalDecision::Deny,
                    "once" => ApprovalDecision::Once,
                    other => return Err(format!("`--approvals` is deny or once, not `{other}`.")),
                };
            }
            other => {
                return Err(format!(
                    "Unknown option `{other}`. Try `subrosa-code --help`."
                ))
            }
        }
    }

    let prompt = prompt.ok_or("A run needs `--prompt` or `--prompt-file`.")?;
    if resume.is_none() {
        if dir.is_none() {
            return Err("A new run needs `--dir`.".into());
        }
        if model.is_none() {
            return Err("A new run needs `--model`.".into());
        }
        if budget_usd.is_none() {
            return Err(
                "A new run needs `--budget`: it spends with no one watching, so it needs a limit."
                    .into(),
            );
        }
    }
    Ok(Invocation::Run(RunArgs {
        dir,
        model,
        mode,
        budget_usd,
        resume,
        prompt,
        data_dir,
        approvals,
    }))
}

fn set_once<T>(slot: &mut Option<T>, value: T, name: &str) -> Result<(), String> {
    if slot.is_some() {
        return Err(format!("`{name}` is given twice."));
    }
    *slot = Some(value);
    Ok(())
}

/// A positive dollar amount, `$` and a decimal comma tolerated.
pub fn parse_budget(raw: &str) -> Result<f64, String> {
    let cleaned = raw.trim().trim_start_matches('$').replace(',', ".");
    let value: f64 = cleaned
        .parse()
        .map_err(|_| format!("`--budget` is an amount in dollars, not `{raw}`."))?;
    if !value.is_finite() || value <= 0.0 {
        return Err("`--budget` must be more than zero.".into());
    }
    if value > MAX_BUDGET_USD {
        return Err(format!(
            "`--budget` is capped at {MAX_BUDGET_USD} dollars for one run."
        ));
    }
    Ok(value)
}

/// A run id names a file in the data folder, so it is held to a plain shape:
/// no separator, no dot, no traversal.
pub fn parse_run_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    if valid {
        Ok(id.to_string())
    } else {
        Err(format!("`{raw}` is not a run id."))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Result<RunArgs, String> {
        match parse(std::iter::once("run").chain(args.iter().copied()))? {
            Invocation::Run(args) => Ok(args),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_new_run_reads_every_flag() {
        let args = run(&[
            "--dir",
            "/work/repo",
            "--model",
            "kimi-k2-7-code",
            "--mode",
            "plan",
            "--budget",
            "0.5",
            "--prompt",
            "crée hello.py",
            "--data-dir=/data",
            "--approvals",
            "once",
        ])
        .unwrap();
        assert_eq!(args.dir, Some(PathBuf::from("/work/repo")));
        assert_eq!(args.model.as_deref(), Some("kimi-k2-7-code"));
        assert_eq!(args.mode, Some(RunMode::Plan));
        assert_eq!(args.budget_usd, Some(0.5));
        assert_eq!(args.prompt, PromptSource::Text("crée hello.py".into()));
        assert_eq!(args.data_dir, Some(PathBuf::from("/data")));
        assert_eq!(args.approvals, ApprovalDecision::Once);
        assert_eq!(args.resume, None);
    }

    #[test]
    fn a_new_run_needs_a_folder_a_model_a_budget_and_a_prompt() {
        let base = [
            "--dir", "/w", "--model", "m", "--budget", "1", "--prompt", "p",
        ];
        assert!(run(&base).is_ok());
        for missing in ["--dir", "--model", "--budget", "--prompt"] {
            let index = base.iter().position(|a| *a == missing).unwrap();
            let mut args = base.to_vec();
            args.drain(index..index + 2);
            let error = run(&args).unwrap_err();
            assert!(
                error.contains(missing.trim_start_matches("--")) || error.contains("prompt"),
                "{error}"
            );
        }
    }

    #[test]
    fn a_resume_takes_the_rest_from_the_run() {
        let args = run(&["--resume", "run_abc-1", "--prompt-file", "-"]).unwrap();
        assert_eq!(args.resume.as_deref(), Some("run_abc-1"));
        assert_eq!(args.prompt, PromptSource::Stdin);
        assert_eq!(args.budget_usd, None);
    }

    #[test]
    fn mistakes_are_refused_with_a_reason() {
        assert!(run(&["--resume", "../etc/passwd", "--prompt", "p"]).is_err());
        assert!(
            run(&["--resume", "r", "--prompt", "p", "--prompt-file", "f"])
                .unwrap_err()
                .contains("twice")
        );
        assert!(run(&["--resume", "r", "--prompt", "p", "--mode", "auto"]).is_err());
        assert!(run(&["--resume", "r", "--prompt", "p", "--budget", "0"]).is_err());
        assert!(run(&["--resume", "r", "--prompt", "p", "--budget", "250"]).is_err());
        assert!(run(&["--resume", "r", "--prompt", "p", "--model", "two words"]).is_err());
        assert!(run(&["--resume", "r", "--prompt", "p", "--frobnicate"]).is_err());
        assert!(run(&["--resume", "r", "--prompt"])
            .unwrap_err()
            .contains("needs a value"));
        assert!(parse(["deploy"]).is_err());
    }

    #[test]
    fn help_and_version_need_no_run() {
        assert_eq!(parse(Vec::<String>::new()).unwrap(), Invocation::Help);
        assert_eq!(parse(["--help"]).unwrap(), Invocation::Help);
        assert_eq!(parse(["run", "--help"]).unwrap(), Invocation::Help);
        assert_eq!(parse(["-V"]).unwrap(), Invocation::Version);
    }

    #[test]
    fn a_budget_reads_like_money() {
        assert_eq!(parse_budget("$2").unwrap(), 2.0);
        assert_eq!(parse_budget("0,03").unwrap(), 0.03);
        assert!(parse_budget("NaN").is_err());
        assert!(parse_budget("-1").is_err());
    }
}
