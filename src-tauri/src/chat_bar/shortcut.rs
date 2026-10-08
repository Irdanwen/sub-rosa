//! The chat bar's shortcut: what it may be, what it may not collide with,
//! and how each platform names its key.

use serde::{Deserialize, Serialize};

use crate::domain::types::AppError;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Modifiers {
    /// Cmd on macOS. Not offered on Windows, where it would be the Windows
    /// key the system keeps for itself.
    pub command: bool,
    pub control: bool,
    /// Option on macOS, Alt on Windows.
    pub option: bool,
    pub shift: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatBarShortcut {
    /// A `KeyboardEvent.code`: `Space`, `KeyK`, `Digit1`, `Slash`…
    pub code: String,
    pub modifiers: Modifiers,
    pub label: String,
}

impl Default for ChatBarShortcut {
    fn default() -> Self {
        default_shortcut()
    }
}

/// Option+Space on macOS, Alt+Space on Windows.
pub fn default_shortcut() -> ChatBarShortcut {
    let modifiers = Modifiers {
        option: true,
        ..Modifiers::default()
    };
    ChatBarShortcut {
        label: label_for("Space", &modifiers),
        code: "Space".to_string(),
        modifiers,
    }
}

/// How the shortcut reads on this platform: `Opt+Space`, `Alt+Space`.
pub fn label_for(code: &str, modifiers: &Modifiers) -> String {
    let mac = cfg!(target_os = "macos");
    let mut parts: Vec<String> = Vec::new();
    if modifiers.command {
        parts.push(if mac { "Cmd" } else { "Win" }.to_string());
    }
    if modifiers.control {
        parts.push("Ctrl".to_string());
    }
    if modifiers.option {
        parts.push(if mac { "Opt" } else { "Alt" }.to_string());
    }
    if modifiers.shift {
        parts.push("Shift".to_string());
    }
    parts.push(key_label(code));
    parts.join("+")
}

fn key_label(code: &str) -> String {
    if let Some(letter) = code.strip_prefix("Key") {
        return letter.to_string();
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return digit.to_string();
    }
    match code {
        "Slash" => "/",
        "Period" => ".",
        "Comma" => ",",
        "Semicolon" => ";",
        "Quote" => "'",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Backquote" => "`",
        "Minus" => "-",
        "Equal" => "=",
        "Backslash" => "\\",
        other => other,
    }
    .to_string()
}

/// Reads `Opt+Space`, `Alt+Space`, `Cmd+Shift+K`, `ctrl+/`.
pub fn parse(label: &str) -> Option<ChatBarShortcut> {
    let mut modifiers = Modifiers::default();
    let mut key: Option<String> = None;
    for part in label
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        match part.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" | "win" | "super" => modifiers.command = true,
            "ctrl" | "control" => modifiers.control = true,
            "opt" | "option" | "alt" => modifiers.option = true,
            "shift" => modifiers.shift = true,
            _ if key.is_none() => key = Some(code_for_key(part)?),
            _ => return None,
        }
    }
    let code = key?;
    Some(ChatBarShortcut {
        label: label_for(&code, &modifiers),
        code,
        modifiers,
    })
}

fn code_for_key(key: &str) -> Option<String> {
    let lower = key.to_ascii_lowercase();
    if lower == "space" {
        return Some("Space".to_string());
    }
    let mut chars = key.chars();
    if let (Some(single), None) = (chars.next(), chars.next()) {
        if single.is_ascii_alphabetic() {
            return Some(format!("Key{}", single.to_ascii_uppercase()));
        }
        if single.is_ascii_digit() {
            return Some(format!("Digit{single}"));
        }
        let code = match single {
            '/' => "Slash",
            '.' => "Period",
            ',' => "Comma",
            ';' => "Semicolon",
            '\'' => "Quote",
            '[' => "BracketLeft",
            ']' => "BracketRight",
            '`' => "Backquote",
            '-' => "Minus",
            '=' => "Equal",
            _ => return None,
        };
        return Some(code.to_string());
    }
    // Already a code (`KeyK`, `Enter`, `F5`).
    windows_virtual_key(key).map(|_| key.to_string())
}

/// What a shortcut must not be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    /// A plain key would fire while the person types.
    NeedsModifier,
    UnsupportedKey,
    /// The system already answers it (Spotlight, input sources, the app
    /// switcher, the Windows key).
    Reserved,
    /// Push to talk or toggle dictation already uses it (ADR-0041).
    TakenByDictation,
}

impl Problem {
    pub fn into_error(self) -> AppError {
        match self {
            Self::NeedsModifier => AppError::new(
                "chat_bar_shortcut_invalid",
                "Add Ctrl, Option, Alt or Cmd to the shortcut so it does not fire while you type.",
            ),
            Self::UnsupportedKey => AppError::new(
                "chat_bar_shortcut_invalid",
                "That key cannot be used for the chat bar. Try a letter, a number or Space.",
            ),
            Self::Reserved => AppError::new(
                "chat_bar_shortcut_invalid",
                "Your system already uses this shortcut. Pick another one.",
            ),
            Self::TakenByDictation => AppError::new(
                "chat_bar_shortcut_invalid",
                "A dictation shortcut already uses this. Pick another one, or change the dictation shortcut first.",
            ),
        }
    }
}

/// A shortcut someone else holds, as `(code, modifiers, fn)`.
pub struct Taken {
    pub code: String,
    pub modifiers: Modifiers,
    pub function: bool,
}

pub fn validate(candidate: &ChatBarShortcut, taken: &[Taken]) -> Result<ChatBarShortcut, Problem> {
    let modifiers = &candidate.modifiers;
    let code = candidate.code.trim();
    if is_reserved(code, modifiers) {
        return Err(Problem::Reserved);
    }
    if windows_virtual_key(code).is_none() || mac_key_code(code).is_none() {
        return Err(Problem::UnsupportedKey);
    }
    if !(modifiers.command || modifiers.control || modifiers.option) {
        // Shift alone is still typing.
        return Err(Problem::NeedsModifier);
    }
    if taken
        .iter()
        .any(|other| !other.function && other.code == code && &other.modifiers == modifiers)
    {
        return Err(Problem::TakenByDictation);
    }
    Ok(ChatBarShortcut {
        code: code.to_string(),
        modifiers: modifiers.clone(),
        label: label_for(code, modifiers),
    })
}

fn is_reserved(code: &str, modifiers: &Modifiers) -> bool {
    let only = |command: bool, control: bool, option: bool, shift: bool| {
        modifiers.command == command
            && modifiers.control == control
            && modifiers.option == option
            && modifiers.shift == shift
    };
    if cfg!(target_os = "windows") && modifiers.command {
        return true;
    }
    match code {
        // Spotlight, Finder search, input sources.
        "Space" => {
            only(true, false, false, false)
                || only(true, false, true, false)
                || only(false, true, false, false)
                || only(false, true, true, false) && cfg!(target_os = "macos")
        }
        "Tab" => modifiers.command || modifiers.option,
        "KeyQ" | "KeyW" | "KeyH" | "KeyM" => only(true, false, false, false),
        "F4" => only(false, false, true, false),
        "Escape" | "Delete" => true,
        _ => false,
    }
}

/// The macOS virtual key code (Carbon), as the dictation helper registers it.
pub fn mac_key_code(code: &str) -> Option<u32> {
    crate::dictation::key_code_for_code(code)
}

/// The Windows virtual-key code.
pub fn windows_virtual_key(code: &str) -> Option<u32> {
    if let Some(letter) = code.strip_prefix("Key") {
        let mut chars = letter.chars();
        if let (Some(single), None) = (chars.next(), chars.next()) {
            if single.is_ascii_uppercase() {
                return Some(single as u32);
            }
        }
        return None;
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let mut chars = digit.chars();
        if let (Some(single), None) = (chars.next(), chars.next()) {
            if single.is_ascii_digit() {
                return Some(single as u32);
            }
        }
        return None;
    }
    Some(match code {
        "Space" => 0x20,
        "Enter" => 0x0D,
        "Tab" => 0x09,
        "Escape" => 0x1B,
        "Backspace" => 0x08,
        "Delete" => 0x2E,
        "Semicolon" => 0xBA,
        "Equal" => 0xBB,
        "Comma" => 0xBC,
        "Minus" => 0xBD,
        "Period" => 0xBE,
        "Slash" => 0xBF,
        "Backquote" => 0xC0,
        "BracketLeft" => 0xDB,
        "Backslash" => 0xDC,
        "BracketRight" => 0xDD,
        "Quote" => 0xDE,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "F1" => 0x70,
        "F2" => 0x71,
        "F3" => 0x72,
        "F4" => 0x73,
        "F5" => 0x74,
        "F6" => 0x75,
        "F7" => 0x76,
        "F8" => 0x77,
        "F9" => 0x78,
        "F10" => 0x79,
        "F11" => 0x7A,
        "F12" => 0x7B,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mods(command: bool, control: bool, option: bool, shift: bool) -> Modifiers {
        Modifiers {
            command,
            control,
            option,
            shift,
        }
    }

    #[test]
    fn labels_parse_back_to_the_same_shortcut() {
        let parsed = parse("Opt+Space").unwrap();
        assert_eq!(parsed.code, "Space");
        assert_eq!(parsed.modifiers, mods(false, false, true, false));
        assert_eq!(parse("alt + space").unwrap().modifiers, parsed.modifiers);
        let k = parse("Cmd+Shift+K").unwrap();
        assert_eq!(k.code, "KeyK");
        assert_eq!(k.modifiers, mods(true, false, false, true));
        assert_eq!(parse("Ctrl+/").unwrap().code, "Slash");
        assert_eq!(parse(&k.label).unwrap(), k);
        assert_eq!(parse("Ctrl+K+J"), None);
        assert_eq!(parse("Ctrl+🙂"), None);
        assert_eq!(parse("Ctrl"), None);
    }

    #[test]
    fn the_default_is_option_space_and_is_valid() {
        let shortcut = default_shortcut();
        assert_eq!(shortcut.code, "Space");
        assert!(shortcut.modifiers.option);
        assert!(validate(&shortcut, &[]).is_ok());
    }

    #[test]
    fn a_shortcut_needs_a_real_modifier() {
        let plain = parse("K").unwrap();
        assert_eq!(validate(&plain, &[]), Err(Problem::NeedsModifier));
        let shifted = parse("Shift+K").unwrap();
        assert_eq!(validate(&shifted, &[]), Err(Problem::NeedsModifier));
        assert!(validate(&parse("Ctrl+Opt+K").unwrap(), &[]).is_ok());
    }

    #[test]
    fn system_shortcuts_are_refused() {
        assert_eq!(
            validate(&parse("Ctrl+Space").unwrap(), &[]),
            Err(Problem::Reserved)
        );
        assert_eq!(
            validate(&parse("Alt+F4").unwrap(), &[]),
            Err(Problem::Reserved)
        );
        if cfg!(target_os = "macos") {
            assert_eq!(
                validate(&parse("Cmd+Space").unwrap(), &[]),
                Err(Problem::Reserved)
            );
            assert_eq!(
                validate(&parse("Cmd+Q").unwrap(), &[]),
                Err(Problem::Reserved)
            );
        }
    }

    #[test]
    fn a_dictation_shortcut_is_never_shared() {
        let toggle = Taken {
            code: "KeyT".to_string(),
            modifiers: mods(false, true, true, false),
            function: false,
        };
        let fn_space = Taken {
            code: "Space".to_string(),
            modifiers: mods(false, false, true, false),
            function: true,
        };
        assert_eq!(
            validate(&parse("Ctrl+Opt+T").unwrap(), &[toggle]),
            Err(Problem::TakenByDictation)
        );
        // Fn+Opt+Space is a different chord from Opt+Space.
        assert!(validate(&parse("Opt+Space").unwrap(), &[fn_space]).is_ok());
    }

    #[test]
    fn keys_have_codes_on_both_platforms() {
        assert_eq!(windows_virtual_key("KeyK"), Some(0x4B));
        assert_eq!(windows_virtual_key("Digit1"), Some(0x31));
        assert_eq!(windows_virtual_key("Space"), Some(0x20));
        assert_eq!(mac_key_code("Space"), Some(0x31));
        assert_eq!(windows_virtual_key("Keyk"), None);
        assert_eq!(
            validate(&parse("Ctrl+F1").unwrap(), &[]).map(|s| s.code),
            Ok("F1".to_string())
        );
    }
}
