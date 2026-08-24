//! The local production surface, as one action table.
//!
//! Two callers, one implementation. The desktop agent reaches it over the
//! app's local proxy (`/v1/studio/request`, in `hermes_bridge`) and names an
//! action like `bible.save`; the agent on the phone is already inside the
//! process and names the tool `bible` with the action in its arguments. Two
//! dispatch tables would drift, and the drift would show up as a tool that
//! works on one shell and not the other, which is the hardest kind of bug to
//! see. So the second shape is translated into the first, here, and this
//! module compiles on both platforms.
//!
//! Everything reachable from here is a command the app already exposes to its
//! own webview. No key, no path, no gallery file crosses this boundary.

use crate::domain::types::AppError;
use tauri::AppHandle;

/// The same production surface, for a caller that is already inside the
/// process (agent-lite on the phone).
///
/// One implementation, two callers: the MCP names `bible.save`, agent-lite
/// names the tool `bible` and puts the action in its arguments. Rather than
/// two dispatch tables that drift, the second shape is translated into the
/// first here.
pub async fn studio_action(
    app: AppHandle,
    tool: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let (action, params) = translate(tool, args);
    dispatch(app, &action, params).await
}

/// The translation itself, pure so it can be tested without an app handle.
///
/// The action must not survive into the params: it would reach a command's
/// `Deserialize` as an unknown field.
pub fn translate(tool: &str, args: &serde_json::Value) -> (String, serde_json::Value) {
    let action = args
        .get("action")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let mut params = args.clone();
    if let Some(object) = params.as_object_mut() {
        object.remove("action");
    }
    (format!("{tool}.{action}"), params)
}

/// Action → command. Params reuse the commands' own camelCase request shapes,
/// so the MCP, the webview and this proxy stay one contract.
pub async fn dispatch(
    app: AppHandle,
    action: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    use serde_json::Value;

    fn required_param(params: &Value, key: &str) -> Result<String, AppError> {
        params
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::new("studio_invalid_params", format!("{key} is required")))
    }
    fn parsed<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, AppError> {
        serde_json::from_value(params)
            .map_err(|error| AppError::new("studio_invalid_params", error.to_string()))
    }
    fn as_json<T: serde::Serialize>(value: T) -> Result<Value, AppError> {
        serde_json::to_value(value)
            .map_err(|error| AppError::new("studio_serialize_failed", error.to_string()))
    }

    match action {
        "bible.list" => as_json(crate::bible::list_bible_entries(app).await?),
        "bible.save" => as_json(crate::bible::save_bible_entry(app, parsed(params)?).await?),
        "bible.delete" => {
            crate::bible::delete_bible_entry(app, required_param(&params, "id")?).await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "bible.attach" => as_json(crate::bible::add_bible_ref(app, parsed(params)?).await?),
        "bible.detach" => {
            crate::bible::remove_bible_ref(app, required_param(&params, "id")?).await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "shots.plan" => {
            as_json(crate::shotlist::shot_list_plan(app, required_param(&params, "noteId")?).await?)
        }
        "shots.build" => as_json(
            crate::shotlist::build_shot_list(app, required_param(&params, "noteId")?).await?,
        ),
        "shots.read" => {
            as_json(crate::shotlist::shot_list(app, required_param(&params, "noteId")?).await?)
        }
        "shots.forget" => {
            crate::shotlist::forget_shot_list(app, required_param(&params, "noteId")?).await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        other => Err(AppError::new(
            "studio_unknown_action",
            format!("Unknown studio action: {other}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::translate;
    use serde_json::json;

    #[test]
    fn the_two_shells_end_up_at_the_same_action() {
        // Two dispatch tables would drift, and the drift shows up as a tool
        // that works on the desktop and not on the phone.
        let (action, params) = translate(
            "bible",
            &json!({ "action": "save", "name": "Nera", "kind": "character" }),
        );
        assert_eq!(action, "bible.save");
        assert_eq!(params, json!({ "name": "Nera", "kind": "character" }));
    }

    #[test]
    fn a_missing_action_names_something_no_table_answers() {
        // Rather than silently dispatching `bible` and hitting whatever the
        // first arm happens to be.
        let (action, _) = translate("shots", &json!({ "noteId": "n1" }));
        assert_eq!(action, "shots.");
    }

    #[test]
    fn the_action_never_survives_into_the_params() {
        // It would reach a command's Deserialize as an unknown field.
        let (_, params) = translate("shots", &json!({ "action": "plan", "noteId": "n1" }));
        assert_eq!(params, json!({ "noteId": "n1" }));
    }
}
