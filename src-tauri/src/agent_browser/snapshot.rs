//! A page as the agent reads it: the accessibility tree as indented text,
//! every control it can act on numbered with a ref (`e12`), and the rules
//! about which controls it must leave to the person.
//!
//! The accessibility tree rather than the DOM: it is what a screen reader
//! hears, so it names controls the way a person would ("Search", "Add to
//! cart") and drops the layout noise, which keeps a page to a few hundred
//! lines the model can actually read.

use std::collections::HashMap;

use serde_json::Value;

/// Roles the agent can act on. Everything else is read, not clicked.
const INTERACTIVE_ROLES: &[&str] = &[
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "listbox",
    "option",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "spinbutton",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "treeitem",
    "textfield",
];

/// Roles worth a line even though nothing can be done with them: they give
/// the page its shape.
const STRUCTURAL_ROLES: &[&str] = &[
    "heading",
    "StaticText",
    "image",
    "img",
    "dialog",
    "alert",
    "alertdialog",
    "navigation",
    "main",
    "form",
    "table",
    "row",
    "cell",
    "listitem",
];

/// Past this the snapshot is cut, and says so.
pub const MAX_SNAPSHOT_CHARS: usize = 14_000;

/// What a ref points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefTarget {
    pub backend_node_id: i64,
    pub role: String,
    pub name: String,
}

#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub text: String,
    pub refs: HashMap<String, RefTarget>,
    pub truncated: bool,
}

/// Builds the snapshot from `Accessibility.getFullAXTree`'s `nodes`.
pub fn from_ax_tree(result: &Value) -> Snapshot {
    let empty = Vec::new();
    let nodes = result
        .get("nodes")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut by_id: HashMap<&str, &Value> = HashMap::new();
    for node in nodes {
        if let Some(id) = node.get("nodeId").and_then(Value::as_str) {
            by_id.insert(id, node);
        }
    }
    let root = nodes
        .iter()
        .find(|node| node.get("parentId").is_none())
        .or_else(|| nodes.first());
    let mut snapshot = Snapshot::default();
    let mut counter = 0_usize;
    if let Some(root) = root {
        walk(root, &by_id, 0, &mut snapshot, &mut counter);
    }
    snapshot
}

fn walk(
    node: &Value,
    by_id: &HashMap<&str, &Value>,
    depth: usize,
    out: &mut Snapshot,
    counter: &mut usize,
) {
    if out.text.len() >= MAX_SNAPSHOT_CHARS {
        out.truncated = true;
        return;
    }
    let ignored = node.get("ignored").and_then(Value::as_bool) == Some(true);
    let role = string_at(node, &["role", "value"]);
    let name = string_at(node, &["name", "value"]);
    let mut next_depth = depth;
    if !ignored {
        if let Some(line) = line_for(node, &role, &name, out, counter) {
            out.text.push_str(&"  ".repeat(depth.min(12)));
            out.text.push_str(&line);
            out.text.push('\n');
            next_depth = depth + 1;
        }
    }
    let children = node
        .get("childIds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for child in children {
        if let Some(child) = child.as_str().and_then(|id| by_id.get(id)) {
            walk(child, by_id, next_depth, out, counter);
        }
    }
}

fn line_for(
    node: &Value,
    role: &str,
    name: &str,
    out: &mut Snapshot,
    counter: &mut usize,
) -> Option<String> {
    let name = clip(name.trim(), 160);
    if INTERACTIVE_ROLES.contains(&role) {
        let backend = node.get("backendDOMNodeId").and_then(Value::as_i64)?;
        *counter += 1;
        let reference = format!("e{counter}");
        out.refs.insert(
            reference.clone(),
            RefTarget {
                backend_node_id: backend,
                role: role.to_string(),
                name: name.clone(),
            },
        );
        let mut line = format!("[{reference}] {role}");
        if !name.is_empty() {
            line.push_str(&format!(" \"{name}\""));
        }
        line.push_str(&states(node, role));
        return Some(line);
    }
    if !STRUCTURAL_ROLES.contains(&role) {
        return None;
    }
    if role == "StaticText" {
        return (!name.is_empty()).then(|| format!("text \"{name}\""));
    }
    if name.is_empty() && !matches!(role, "dialog" | "alert" | "alertdialog" | "form" | "main") {
        return None;
    }
    let mut line = role.to_string();
    if !name.is_empty() {
        line.push_str(&format!(" \"{name}\""));
    }
    if role == "heading" {
        if let Some(level) = property(node, "level").and_then(Value::as_i64) {
            line.push_str(&format!(" level {level}"));
        }
    }
    Some(line)
}

/// The states a person would see: checked, expanded, disabled, focused, and
/// whether a field already holds something. A field's value itself is never
/// copied out: it may be what the person typed, and a password field's mask
/// is still the length of the password.
fn states(node: &Value, role: &str) -> String {
    let mut parts = Vec::new();
    for (property_name, label) in [
        ("checked", "checked"),
        ("pressed", "pressed"),
        ("selected", "selected"),
        ("expanded", "expanded"),
    ] {
        match property(node, property_name) {
            Some(Value::Bool(true)) => parts.push(label.to_string()),
            Some(Value::String(value)) if value == "true" => parts.push(label.to_string()),
            _ => {}
        }
    }
    if matches!(property(node, "disabled"), Some(Value::Bool(true))) {
        parts.push("disabled".to_string());
    }
    if matches!(property(node, "focused"), Some(Value::Bool(true))) {
        parts.push("focused".to_string());
    }
    let value = string_at(node, &["value", "value"]);
    if !value.is_empty() {
        if matches!(role, "combobox" | "listbox" | "slider" | "spinbutton") {
            parts.push(format!("value \"{}\"", clip(&value, 80)));
        } else if matches!(role, "textbox" | "searchbox" | "textfield") {
            parts.push("filled".to_string());
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ({})", parts.join(", "))
    }
}

fn property<'a>(node: &'a Value, name: &str) -> Option<&'a Value> {
    node.get("properties")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))?
        .get("value")?
        .get("value")
}

fn string_at(node: &Value, path: &[&str]) -> String {
    let mut current = node;
    for key in path {
        match current.get(key) {
            Some(next) => current = next,
            None => return String::new(),
        }
    }
    match current {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        _ => String::new(),
    }
}

fn clip(text: &str, max_chars: usize) -> String {
    let single_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.chars().count() <= max_chars {
        return single_line.replace('"', "'");
    }
    let clipped: String = single_line.chars().take(max_chars).collect();
    format!("{}…", clipped.replace('"', "'"))
}

/// Why a field is the person's to fill, never the agent's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitive {
    Password,
    Payment,
    OneTimeCode,
}

impl Sensitive {
    /// What the tool result tells the agent to say.
    pub fn refusal(self) -> &'static str {
        match self {
            Self::Password => "This is a password field. Sub Rosa never types passwords: tell the person to type it in the browser window themselves, then continue.",
            Self::Payment => "This is a payment field (card number, expiry, security code or bank details). Sub Rosa never enters payment details: tell the person to fill it in the browser window themselves, then continue.",
            Self::OneTimeCode => "This is a one-time code field. Sub Rosa never enters sign-in codes: tell the person to type it in the browser window themselves, then continue.",
        }
    }
}

const PASSWORD_HINTS: &[&str] = &[
    "password",
    "passwd",
    "passcode",
    "mot de passe",
    "motdepasse",
    "kennwort",
    "passwort",
    "contraseña",
    "senha",
];

const PAYMENT_HINTS: &[&str] = &[
    "cardnumber",
    "card number",
    "card-number",
    "card_number",
    "ccnum",
    "cc-num",
    "cc_number",
    "creditcard",
    "credit card",
    "credit-card",
    "cvc",
    "cvv",
    "csc",
    "security code",
    "securitycode",
    "card verification",
    "expiry",
    "expiration",
    "exp-date",
    "exp_date",
    "expdate",
    "iban",
    "routing number",
    "account number",
    "numéro de carte",
    "numero de carte",
    "cryptogramme",
    "date d'expiration",
    "kartennummer",
    "prüfnummer",
];

const OTP_HINTS: &[&str] = &[
    "one-time-code",
    "one time code",
    "otp",
    "2fa",
    "verification code",
    "authentication code",
    "code de vérification",
];

/// Decides from the element (`DOM.describeNode`) and the name the
/// accessibility tree gave it. `attributes` is CDP's flat `[name, value, …]`.
pub fn sensitive_field(node_name: &str, attributes: &[String], ax_name: &str) -> Option<Sensitive> {
    let mut attrs: HashMap<String, String> = HashMap::new();
    for pair in attributes.chunks(2) {
        if let [key, value] = pair {
            attrs.insert(key.to_ascii_lowercase(), value.to_lowercase());
        }
    }
    let input_type = attrs.get("type").map(String::as_str).unwrap_or_default();
    if node_name.eq_ignore_ascii_case("input") && input_type == "password" {
        return Some(Sensitive::Password);
    }
    let autocomplete = attrs
        .get("autocomplete")
        .map(String::as_str)
        .unwrap_or_default();
    for token in autocomplete.split_whitespace() {
        if token == "current-password" || token == "new-password" {
            return Some(Sensitive::Password);
        }
        if token.starts_with("cc-") {
            return Some(Sensitive::Payment);
        }
        if token == "one-time-code" {
            return Some(Sensitive::OneTimeCode);
        }
    }
    // Names, ids, placeholders and labels, read together: sites name their
    // card fields every way there is, and a false refusal costs the person a
    // few keystrokes while a false pass costs them their card number.
    let haystack = [
        attrs.get("name"),
        attrs.get("id"),
        attrs.get("placeholder"),
        attrs.get("aria-label"),
        attrs.get("data-testid"),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .chain(std::iter::once(ax_name.to_lowercase()))
    .collect::<Vec<_>>()
    .join(" | ");
    if PASSWORD_HINTS.iter().any(|hint| mentions(&haystack, hint)) {
        return Some(Sensitive::Password);
    }
    if PAYMENT_HINTS.iter().any(|hint| mentions(&haystack, hint)) {
        return Some(Sensitive::Payment);
    }
    if OTP_HINTS.iter().any(|hint| mentions(&haystack, hint)) {
        return Some(Sensitive::OneTimeCode);
    }
    None
}

/// A long hint matches anywhere; a short one (`cvc`, `otp`, `iban`) only as a
/// word of its own, so "footprint" is not a one-time code.
fn mentions(haystack: &str, hint: &str) -> bool {
    if hint.chars().count() > 4 {
        return haystack.contains(hint);
    }
    haystack.split(|c: char| !c.is_alphanumeric()).any(|word| {
        word == hint
            || word
                .strip_prefix(hint)
                .is_some_and(|rest| rest.chars().all(|c| c.is_ascii_digit()))
    })
}

/// Run in the page: whether a CAPTCHA is showing. Frames from the usual
/// challenge providers, or an element that calls itself one.
pub const CAPTCHA_PROBE: &str = r#"(() => {
  const pattern = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha|captcha/i;
  const frames = Array.from(document.querySelectorAll('iframe'));
  if (frames.some((frame) => pattern.test(frame.src || '') || pattern.test(frame.title || ''))) return true;
  return !!document.querySelector('[class*="captcha" i], [id*="captcha" i], [name*="captcha" i]');
})()"#;

/// Whether a control's name says it belongs to a CAPTCHA ("I'm not a robot").
pub fn is_captcha_control(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("captcha")
        || lower.contains("not a robot")
        || lower.contains("pas un robot")
        || lower.contains("verify you are human")
        || lower.contains("are you human")
}
