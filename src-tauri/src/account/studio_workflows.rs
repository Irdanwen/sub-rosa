//! The Studio's workflows, synchronised (ADR-0118).
//!
//! `studio_workflows` rides the generic row codec: the triggers, the
//! inventory, a conflict and a remote deletion are the registry's. Two things
//! are particular to it, and they live here so the sync engine only names
//! them.
//!
//! * The service names objects by UUID. Every workflow is created under one
//!   (`crypto.randomUUID()` in the webview), so the trigger only keeps back a
//!   row that is not, rather than send what the service would refuse.
//! * A received row is checked the way this device's own save is
//!   (`crate::studio_workflows::save`): a graph that is not a JSON object, an
//!   origin this version does not know, an oversized field. The graph's own
//!   shape stays the webview's: a later format opens read-only there, so a
//!   device that understands less never writes over what a newer one made.

use super::*;
use crate::studio_workflows::{MAX_DEFINITION_BYTES, MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS};
use serde_json::Map;

/// The trigger condition that keeps a workflow without a UUID on the device.
pub(super) fn named_by_uuid(prefix: &str) -> String {
    format!(" AND length({prefix}id)=36 AND {prefix}id NOT GLOB '*[^0-9a-f-]*'")
}

/// Before a received workflow is written: refuse what this device's own save
/// would refuse, and bring the rest inside the same bounds.
pub(super) fn admit_row(row: &mut Map<String, Value>) -> Result<(), AppError> {
    let invalid = || error("sync_format_invalid");
    let text = |row: &Map<String, Value>, field: &str| -> Result<Option<String>, AppError> {
        match row.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.clone())),
            Some(_) => Err(invalid()),
        }
    };
    let definition = text(row, "definition")?.ok_or_else(invalid)?;
    if definition.len() > MAX_DEFINITION_BYTES
        || !serde_json::from_str::<Value>(&definition).is_ok_and(|graph| graph.is_object())
    {
        return Err(invalid());
    }
    let name: String = text(row, "name")?
        .unwrap_or_default()
        .trim()
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();
    row.insert("name".into(), json!(name));
    let description = text(row, "description")?
        .map(|value| {
            value
                .chars()
                .take(MAX_DESCRIPTION_CHARS)
                .collect::<String>()
        })
        .filter(|value| !value.trim().is_empty());
    row.insert("description".into(), json!(description));
    let origin = match text(row, "origin")?.as_deref() {
        Some("import") => "import",
        Some("block") => "block",
        Some("assistant") => "assistant",
        _ => "mine",
    };
    row.insert("origin".into(), json!(origin));
    for field in ["format_version", "created_at", "updated_at"] {
        if !row.get(field).is_some_and(Value::is_i64) {
            return Err(invalid());
        }
    }
    if row["format_version"]
        .as_i64()
        .is_some_and(|version| version < 1)
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(definition: &str) -> Map<String, Value> {
        json!({
            "id": "6f1c2a52-8d0e-4f52-9b5e-0f3a4c1d2e7b",
            "name": "  Opening shot  ",
            "description": "   ",
            "definition": definition,
            "format_version": 3,
            "origin": "template",
            "created_at": 1,
            "updated_at": 2,
        })
        .as_object()
        .cloned()
        .unwrap()
    }

    #[test]
    fn a_received_workflow_is_bounded_like_a_local_save() {
        let mut received = row(r#"{"nodes":[],"edges":[],"app":{"inputs":[]}}"#);
        admit_row(&mut received).unwrap();
        assert_eq!(received["name"], "Opening shot");
        assert_eq!(received["description"], Value::Null);
        // An origin this version does not know is an ordinary workflow.
        assert_eq!(received["origin"], "mine");
        // A later format is kept as it came: the webview opens it read-only.
        assert_eq!(received["format_version"], 3);
        assert!(received["definition"].as_str().unwrap().contains("\"app\""));
    }

    #[test]
    fn a_graph_that_is_not_an_object_or_a_missing_date_is_refused() {
        for definition in ["[1,2]", "not json", "\"text\""] {
            assert!(admit_row(&mut row(definition)).is_err(), "{definition}");
        }
        let mut undated = row("{}");
        undated.remove("updated_at");
        assert!(admit_row(&mut undated).is_err());
        let mut versionless = row("{}");
        versionless.insert("format_version".into(), json!(0));
        assert!(admit_row(&mut versionless).is_err());
    }
}
