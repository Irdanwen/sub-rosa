//! The Studio's workflows, as the assistant reaches them (ADR-0120): list
//! them, read one, learn the steps a workflow can hold, and propose a new
//! one. A proposal is a draft of its own in the library (origin `assistant`),
//! never a change to a workflow the person has, and never a run: the person
//! keeps or discards it in the Studio, and running is a human gesture that
//! passes the price and the confirmation there.

use crate::domain::types::AppError;
use crate::studio_workflows::{self, SaveWorkflowRequest};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

/// The steps a workflow can hold, as the webview's schema writes them
/// (`step-catalog.json`, kept equal to the schema by a test).
const STEP_CATALOG: &str = include_str!("../../src/lib/studio/workflow/step-catalog.json");
/// The stored graph's shape version (`WORKFLOW_FILE_VERSION` in the webview).
const FORMAT_VERSION: i64 = 2;
const MAX_STEPS: usize = 60;
const MAX_WIRES: usize = 200;
const MAX_PARAMS_BYTES: usize = 32 * 1024;
pub const PROPOSED_EVENT: &str = "subrosa://workflow-proposed";

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("workflow_proposal_invalid", message.into())
}

/// Each step type and the input ports it has.
fn catalog() -> &'static HashMap<String, HashSet<String>> {
    static CATALOG: OnceLock<HashMap<String, HashSet<String>>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let steps: Vec<Value> = serde_json::from_str(STEP_CATALOG).unwrap_or_default();
        steps
            .iter()
            .filter_map(|step| {
                let kind = step.get("type")?.as_str()?.to_string();
                let ports = step
                    .get("inputs")
                    .and_then(Value::as_array)
                    .map(|inputs| {
                        inputs
                            .iter()
                            .filter_map(|input| input.get("id")?.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                Some((kind, ports))
            })
            .collect()
    })
}

async fn pool(app: &AppHandle) -> Result<sqlx_sqlite::SqlitePool, AppError> {
    crate::commands::repositories(app)
        .await
        .map(|repos| repos.pool)
}

fn storage(code: String) -> AppError {
    AppError::new(code.clone(), code)
}

/// The library, in a line per workflow.
pub async fn list(app: AppHandle) -> Result<Value, AppError> {
    let rows = studio_workflows::list(&pool(&app).await?)
        .await
        .map_err(storage)?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|row| {
                let graph: Value = serde_json::from_str(&row.definition).unwrap_or(Value::Null);
                let steps = graph
                    .get("nodes")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                json!({
                    "id": row.id,
                    "name": row.name,
                    "description": row.description,
                    "kind": match row.origin.as_str() {
                        "block" => "block",
                        "assistant" => "proposal",
                        _ => "workflow",
                    },
                    "steps": steps,
                    "app": graph.get("app").is_some(),
                })
            })
            .collect(),
    ))
}

/// One workflow's steps, wires and app.
pub async fn read(app: AppHandle, id: &str) -> Result<Value, AppError> {
    let rows = studio_workflows::list(&pool(&app).await?)
        .await
        .map_err(storage)?;
    let row = rows
        .into_iter()
        .find(|row| row.id == id)
        .ok_or_else(|| AppError::new("workflow_not_found", "No workflow has this id."))?;
    let graph: Value = serde_json::from_str(&row.definition).unwrap_or(Value::Null);
    let steps: Vec<Value> = graph
        .get("nodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .map(|node| {
                    json!({
                        "id": node.get("id"),
                        "type": node.get("type"),
                        "label": node.get("label"),
                        "params": node.get("params"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "steps": steps,
        "wires": graph.get("edges"),
        "blocks": graph.get("blocks"),
        "app": graph.get("app"),
    }))
}

/// The steps a workflow can hold: inputs, output and settings of each.
pub fn steps() -> Result<Value, AppError> {
    serde_json::from_str(STEP_CATALOG)
        .map_err(|error| AppError::new("workflow_catalog_invalid", error.to_string()))
}

/// A proposal checked against the step catalog and written as a definition:
/// steps of known types with ports they have, wires between them, an app
/// pointing at them. Positions the assistant leaves out are laid out in a
/// row, so the draft opens readable.
pub fn proposal_definition(params: &Value) -> Result<(String, Option<String>, Value), AppError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| invalid("A proposal needs a name."))?;
    let description = params
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.trim().is_empty());
    let raw_steps = params
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("A proposal needs its steps."))?;
    if raw_steps.is_empty() || raw_steps.len() > MAX_STEPS {
        return Err(invalid(format!("A proposal holds 1 to {MAX_STEPS} steps.")));
    }
    let catalog = catalog();
    let mut types = HashMap::new();
    let mut nodes = Vec::new();
    for (index, step) in raw_steps.iter().enumerate() {
        let id = step
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 64
                    && id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            })
            .ok_or_else(|| {
                invalid(format!(
                    "Step {} needs a short id of letters and digits.",
                    index + 1
                ))
            })?;
        let kind = step
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| catalog.contains_key(*kind))
            .ok_or_else(|| invalid(format!("Step {id} has a type no workflow holds.")))?;
        if types.insert(id.to_string(), kind.to_string()).is_some() {
            return Err(invalid(format!("Two steps are called {id}.")));
        }
        let params = step.get("params").cloned().unwrap_or_else(|| json!({}));
        if !params.is_object() || params.to_string().len() > MAX_PARAMS_BYTES {
            return Err(invalid(format!(
                "Step {id}'s settings are not a short object."
            )));
        }
        let position = step
            .get("position")
            .filter(|position| position.get("x").is_some_and(Value::is_number))
            .cloned()
            .unwrap_or_else(|| json!({ "x": (index as i64) * 320, "y": 0 }));
        let label: String = step
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(120)
            .collect();
        nodes.push(json!({ "id": id, "type": kind, "label": label, "position": position, "params": params }));
    }
    let raw_wires = params
        .get("wires")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if raw_wires.len() > MAX_WIRES {
        return Err(invalid(format!(
            "A proposal holds at most {MAX_WIRES} wires."
        )));
    }
    let mut edges = Vec::new();
    for wire in &raw_wires {
        let end = |key: &str| {
            wire.get(key)
                .and_then(Value::as_str)
                .filter(|id| types.contains_key(*id))
                .map(str::to_string)
        };
        let (Some(source), Some(target)) = (end("source"), end("target")) else {
            return Err(invalid("A wire names a step the proposal does not have."));
        };
        let port = wire.get("port").and_then(Value::as_str);
        if let Some(port) = port {
            let ports = &catalog[&types[&target]];
            if !port.starts_with("param:") && !ports.contains(port) {
                return Err(invalid(format!(
                    "Step {target} has no input called {port}."
                )));
            }
        }
        edges.push(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "source": source,
            "target": target,
            "targetPort": port,
        }));
    }
    let mut definition = Map::new();
    definition.insert("nodes".into(), Value::Array(nodes));
    definition.insert("edges".into(), Value::Array(edges));
    if let Some(app) = params.get("app").filter(|app| app.is_object()) {
        let known = |id: &Value| id.as_str().is_some_and(|id| types.contains_key(id));
        let fields: Vec<Value> = app
            .get("fields")
            .and_then(Value::as_array)
            .map(|fields| {
                fields
                    .iter()
                    .filter(|field| {
                        field.get("nodeId").is_some_and(known)
                            && field.get("param").is_some_and(Value::is_string)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let outputs: Vec<Value> = app
            .get("outputs")
            .and_then(Value::as_array)
            .map(|outputs| outputs.iter().filter(|id| known(id)).cloned().collect())
            .unwrap_or_default();
        if !fields.is_empty() || !outputs.is_empty() {
            let mut kept = json!({ "fields": fields, "outputs": outputs });
            if let Some(intro) = app.get("intro").and_then(Value::as_str) {
                kept["intro"] = json!(intro);
            }
            definition.insert("app".into(), kept);
        }
    }
    Ok((name.to_string(), description, Value::Object(definition)))
}

/// Write a proposal as a draft of its own and tell an open Studio.
pub async fn propose(app: AppHandle, params: Value) -> Result<Value, AppError> {
    let (name, description, definition) = proposal_definition(&params)?;
    let id = uuid::Uuid::new_v4().to_string();
    studio_workflows::save(
        &pool(&app).await?,
        SaveWorkflowRequest {
            id: id.clone(),
            name: name.clone(),
            description,
            definition: definition.to_string(),
            format_version: Some(FORMAT_VERSION),
            origin: Some("assistant".into()),
            created_at: None,
            updated_at: None,
        },
    )
    .await
    .map_err(storage)?;
    let _ = app.emit(PROPOSED_EVENT, json!({ "id": id }));
    Ok(json!({
        "id": id,
        "name": name,
        "status": "proposed",
        "note": "The workflow waits in the Studio's library, marked as proposed. The person keeps or discards it there, and runs it themselves.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal() -> Value {
        json!({
            "name": "Album cover",
            "steps": [
                { "id": "idea", "type": "textInput", "params": { "text": "Neon rain" } },
                { "id": "cover", "type": "image", "label": "Cover", "params": { "model": "seedream-v4" } },
                { "id": "out", "type": "output" }
            ],
            "wires": [
                { "source": "idea", "target": "cover", "port": "prompt" },
                { "source": "cover", "target": "out", "port": "in" }
            ],
            "app": { "fields": [{ "nodeId": "idea", "param": "text" }, { "nodeId": "ghost", "param": "text" }], "outputs": ["out"] }
        })
    }

    #[test]
    fn a_proposal_becomes_a_laid_out_definition_with_its_app() {
        let (name, _, definition) = proposal_definition(&proposal()).unwrap();
        assert_eq!(name, "Album cover");
        let nodes = definition["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[2]["position"], json!({ "x": 640, "y": 0 }));
        assert_eq!(definition["edges"][0]["targetPort"], "prompt");
        // A field on a step the proposal does not have is let go.
        assert_eq!(definition["app"]["fields"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_step_or_a_port_no_workflow_has_is_refused() {
        let mut unknown = proposal();
        unknown["steps"][1]["type"] = json!("teleport");
        assert_eq!(
            proposal_definition(&unknown).unwrap_err().code,
            "workflow_proposal_invalid"
        );
        let mut port = proposal();
        port["wires"][0]["port"] = json!("nowhere");
        assert!(proposal_definition(&port)
            .unwrap_err()
            .message
            .contains("nowhere"));
        let mut twice = proposal();
        twice["steps"][1]["id"] = json!("idea");
        assert!(proposal_definition(&twice).is_err());
        let mut dangling = proposal();
        dangling["wires"][0]["source"] = json!("ghost");
        assert!(proposal_definition(&dangling).is_err());
        assert!(proposal_definition(&json!({ "name": "Empty", "steps": [] })).is_err());
    }

    #[test]
    fn the_catalog_is_the_schema_the_webview_wrote() {
        let catalog = catalog();
        assert!(catalog["image"].contains("prompt"));
        assert!(catalog["assemble"].contains("clips"));
        assert!(!catalog.contains_key("block"));
    }
}
