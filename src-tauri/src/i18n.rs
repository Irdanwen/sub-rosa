//! The sentences Rust shows by itself, in the person's language (ADR-0047,
//! addendum of 2026-10-08).
//!
//! Most copy reaches the screen through the webview's `t()`. Notifications
//! do not: they are posted from Rust, often while the webview is frozen or
//! not loaded at all (a background launch), so Rust renders them itself,
//! from the same catalogs. Every `src/locales/<lang>.json` is compiled in, the
//! English sentence is the key, a sentence the catalog lacks comes back as written,
//! and `{name}` placeholders are filled the way `t()` fills them.
//!
//! Write `crate::tr!("Your day")` or `crate::tr!("{count} meetings", count =
//! n)`. The macro takes a literal on purpose: `scripts/i18n/rust-sentences.mjs`
//! collects every `tr!("…")` into the catalog, so `pnpm i18n:check` turns red
//! until the sentence has its French.
//!
//! The language is the one the webview resolved (the person's choice, or the
//! system's), told to Rust at every boot and kept in `locale.json`, so a
//! notification posted before the webview loads speaks the same language.
//! With nothing stored yet, the system's language decides.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{LazyLock, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _};

use crate::domain::types::AppError;

const LOCALE_FILE: &str = "locale.json";

/// The languages the app speaks. The serialized names are the webview's
/// locale codes (`src/lib/i18n.ts`), which `locale.json` stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Locale {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "fr")]
    Fr,
    #[serde(rename = "de")]
    De,
    #[serde(rename = "it")]
    It,
    #[serde(rename = "es")]
    Es,
    #[serde(rename = "pt-BR")]
    PtBr,
}

impl Locale {
    const ALL: [Self; 6] = [Self::En, Self::Fr, Self::De, Self::It, Self::Es, Self::PtBr];

    /// A language tag reduced to a language the app has, English otherwise.
    /// The language subtag decides: `de-CH` is German, and any Portuguese
    /// reads the Brazilian catalog, the only Portuguese the app has.
    pub fn from_tag(tag: &str) -> Self {
        let language = tag
            .split(['-', '_', '.'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        match language.as_str() {
            "fr" => Self::Fr,
            "de" => Self::De,
            "it" => Self::It,
            "es" => Self::Es,
            "pt" => Self::PtBr,
            _ => Self::En,
        }
    }

    /// The language's English name, for a prompt that asks a model to
    /// write in it.
    pub fn english_name(self) -> &'static str {
        match self {
            Self::En => "English",
            Self::Fr => "French",
            Self::De => "German",
            Self::It => "Italian",
            Self::Es => "Spanish",
            Self::PtBr => "Brazilian Portuguese",
        }
    }

    fn code(self) -> u8 {
        Self::ALL
            .iter()
            .position(|locale| *locale == self)
            .unwrap_or_default() as u8
    }

    fn from_code(code: u8) -> Self {
        Self::ALL
            .get(usize::from(code))
            .copied()
            .unwrap_or(Self::En)
    }
}

type Catalog = LazyLock<HashMap<String, String>>;

fn parse(raw: &str) -> HashMap<String, String> {
    serde_json::from_str(raw).unwrap_or_default()
}

static FRENCH: Catalog = LazyLock::new(|| parse(include_str!("../../src/locales/fr.json")));
static GERMAN: Catalog = LazyLock::new(|| parse(include_str!("../../src/locales/de.json")));
static ITALIAN: Catalog = LazyLock::new(|| parse(include_str!("../../src/locales/it.json")));
static SPANISH: Catalog = LazyLock::new(|| parse(include_str!("../../src/locales/es.json")));
static BRAZILIAN_PORTUGUESE: Catalog =
    LazyLock::new(|| parse(include_str!("../../src/locales/pt-BR.json")));

/// The catalog of a language, parsed on first use. English has none: the
/// sentence is its own translation.
fn catalog(locale: Locale) -> Option<&'static HashMap<String, String>> {
    match locale {
        Locale::En => None,
        Locale::Fr => Some(&FRENCH),
        Locale::De => Some(&GERMAN),
        Locale::It => Some(&ITALIAN),
        Locale::Es => Some(&SPANISH),
        Locale::PtBr => Some(&BRAZILIAN_PORTUGUESE),
    }
}

static CURRENT: AtomicU8 = AtomicU8::new(0);
static LOCALE_PATH: OnceLock<PathBuf> = OnceLock::new();

#[cfg(test)]
thread_local! {
    static TEST_LOCALE: std::cell::Cell<Option<Locale>> = const { std::cell::Cell::new(None) };
}

/// The language Rust speaks right now.
pub fn current() -> Locale {
    #[cfg(test)]
    if let Some(locale) = TEST_LOCALE.with(std::cell::Cell::get) {
        return locale;
    }
    Locale::from_code(CURRENT.load(Ordering::Relaxed))
}

fn apply(locale: Locale) {
    CURRENT.store(locale.code(), Ordering::Relaxed);
}

/// Runs `body` with `locale` as the language, on this thread only. Each test
/// runs on its own thread, so tests never see each other's language.
#[cfg(test)]
pub fn with_locale<T>(locale: Locale, body: impl FnOnce() -> T) -> T {
    TEST_LOCALE.with(|cell| cell.set(Some(locale)));
    let value = body();
    TEST_LOCALE.with(|cell| cell.set(None));
    value
}

fn interpolate(text: &str, vars: &[(&str, String)]) -> String {
    if vars.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = after.find('}');
        let name = close.map(|close| &after[..close]);
        match (close, name) {
            (Some(close), Some(name))
                if !name.is_empty()
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') =>
            {
                match vars.iter().find(|(key, _)| *key == name) {
                    Some((_, value)) => out.push_str(value),
                    None => {
                        out.push('{');
                        out.push_str(name);
                        out.push('}');
                    }
                }
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The sentence in `locale`: the catalog's translation when it has a
/// non-empty one, the English otherwise, placeholders filled. Pure.
pub fn render(locale: Locale, source: &str, vars: &[(&str, String)]) -> String {
    let text = catalog(locale)
        .and_then(|catalog| catalog.get(source))
        .map(String::as_str)
        .filter(|translated| !translated.trim().is_empty())
        .unwrap_or(source);
    interpolate(text, vars)
}

/// The sentence in the current language. Called by [`crate::tr!`].
pub fn translate(source: &str, vars: &[(&str, String)]) -> String {
    render(current(), source, vars)
}

/// A sentence that was not written here as a literal but is in the catalog
/// because the webview translates it too (a run's stored failure reason).
/// Anything else (a provider's own words) comes back as it came.
pub fn translate_known(sentence: &str) -> String {
    render(current(), sentence, &[])
}

/// One line asking a model to write in the person's language.
pub fn write_in_line() -> String {
    format!("Write in {}.", current().english_name())
}

/// The sentence in the person's language, from `src/locales/<lang>.json`. Takes
/// a literal so the catalog extractor sees every sentence; placeholders are
/// named arguments: `tr!("{count} notes", count = n)`.
#[macro_export]
macro_rules! tr {
    ($source:literal $(,)?) => {
        $crate::i18n::translate($source, &[])
    };
    ($source:literal, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::translate($source, &[$((stringify!($name), ($value).to_string())),+])
    };
}

#[derive(Debug, Serialize, Deserialize)]
struct Stored {
    locale: Locale,
}

fn read_stored(path: &std::path::Path) -> Option<Locale> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Stored>(&raw)
        .ok()
        .map(|stored| stored.locale)
}

/// Loads the language the webview last told us, or the system's.
pub fn setup(app: &tauri::App) {
    let path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(LOCALE_FILE));
    let stored = path.as_deref().and_then(read_stored);
    if let Some(path) = path {
        let _ = LOCALE_PATH.set(path);
    }
    let locale = stored.unwrap_or_else(|| {
        tauri_plugin_os::locale()
            .map(|tag| Locale::from_tag(&tag))
            .unwrap_or(Locale::En)
    });
    apply(locale);
}

/// The webview tells Rust the language it resolved, at every boot. Kept on
/// disk so a notification posted before the next boot speaks it too.
#[tauri::command]
pub fn i18n_set_locale(_app: AppHandle, locale: String) -> Result<(), AppError> {
    let locale = Locale::from_tag(&locale);
    apply(locale);
    if let Some(path) = LOCALE_PATH.get() {
        if read_stored(path) != Some(locale) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let body = serde_json::to_string(&Stored { locale })
                .map_err(|error| AppError::new("locale_invalid", error.to_string()))?;
            std::fs::write(path, body)
                .map_err(|error| AppError::new("locale_save_failed", error.to_string()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn french_comes_from_the_catalog() {
        assert_eq!(
            with_locale(Locale::Fr, || crate::tr!("Your day")),
            "Votre journée"
        );
        assert_eq!(
            with_locale(Locale::En, || crate::tr!("Your day")),
            "Your day"
        );
    }

    #[test]
    fn placeholders_are_filled_in_either_language() {
        let french = with_locale(Locale::Fr, || {
            crate::tr!("{title} is ready", title = "Point produit")
        });
        assert_eq!(french, "Point produit : la note est prête");
        let english = with_locale(Locale::En, || {
            crate::tr!("{title} is ready", title = "Point produit")
        });
        assert_eq!(english, "Point produit is ready");
    }

    #[test]
    fn a_sentence_the_catalog_lacks_stays_english() {
        assert_eq!(
            render(Locale::Fr, "Not a sentence anybody wrote", &[]),
            "Not a sentence anybody wrote"
        );
    }

    #[test]
    fn interpolation_keeps_unknown_and_stray_braces() {
        assert_eq!(
            interpolate("{a} and {b} and { not } {", &[("a", "1".into())]),
            "1 and {b} and { not } {"
        );
    }

    #[test]
    fn tags_reduce_to_a_language_the_app_has() {
        assert_eq!(Locale::from_tag("fr-CH"), Locale::Fr);
        assert_eq!(Locale::from_tag("fr_FR.UTF-8"), Locale::Fr);
        assert_eq!(Locale::from_tag("FR"), Locale::Fr);
        assert_eq!(Locale::from_tag("de-DE"), Locale::De);
        assert_eq!(Locale::from_tag("de_CH"), Locale::De);
        assert_eq!(Locale::from_tag("it-IT"), Locale::It);
        assert_eq!(Locale::from_tag("es-419"), Locale::Es);
        assert_eq!(Locale::from_tag("pt-BR"), Locale::PtBr);
        assert_eq!(Locale::from_tag("pt-PT"), Locale::PtBr);
        assert_eq!(Locale::from_tag("ja-JP"), Locale::En);
        assert_eq!(Locale::from_tag(""), Locale::En);
    }

    #[test]
    fn every_catalog_is_compiled_in_and_complete_for_the_rust_sentences() {
        // The catalogs the binary carries: the JS gate keeps them complete,
        // and this proves Rust reads the same files.
        let rust_sentences: Vec<String> =
            serde_json::from_str(include_str!("../../src/locales/backend-messages.json")).unwrap();
        for locale in Locale::ALL
            .into_iter()
            .filter(|locale| *locale != Locale::En)
        {
            let catalog = catalog(locale).unwrap();
            assert!(
                catalog.len() > 1000,
                "{locale:?} catalog is not compiled in"
            );
            for sentence in &rust_sentences {
                assert!(
                    catalog
                        .get(sentence)
                        .is_some_and(|value| !value.trim().is_empty()),
                    "{locale:?} lacks {sentence:?}"
                );
            }
        }
    }

    #[test]
    fn each_language_renders_its_own_catalog() {
        for locale in [Locale::De, Locale::It, Locale::Es, Locale::PtBr] {
            let rendered = with_locale(locale, || crate::tr!("Your day"));
            assert!(!rendered.is_empty());
            assert_ne!(rendered, "Your day", "{locale:?}");
        }
    }

    #[test]
    fn codes_and_tags_round_trip() {
        for locale in Locale::ALL {
            assert_eq!(Locale::from_code(locale.code()), locale);
            let tag = serde_json::to_value(locale).unwrap();
            assert_eq!(Locale::from_tag(tag.as_str().unwrap()), locale);
        }
        assert_eq!(Locale::from_code(200), Locale::En);
    }

    #[test]
    fn the_stored_choice_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOCALE_FILE);
        std::fs::write(&path, r#"{"locale":"fr"}"#).unwrap();
        assert_eq!(read_stored(&path), Some(Locale::Fr));
        std::fs::write(&path, r#"{"locale":"pt-BR"}"#).unwrap();
        assert_eq!(read_stored(&path), Some(Locale::PtBr));
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(read_stored(&path), None);
    }
}
