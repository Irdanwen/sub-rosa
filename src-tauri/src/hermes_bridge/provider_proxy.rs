//! Request shaping on the provider proxy every Hermes process talks to: the
//! model listing it advertises, and the reasoning-effort alias the desktop
//! encodes into a model name (ADR-0080).

/// The marker the desktop appends to a model id to carry a reasoning effort
/// (`src/lib/desktop-reasoning-effort.ts`). Venice and Carpe Diem ids never
/// contain `@`, so a real id cannot be mistaken for an alias.
const REASONING_EFFORT_ALIAS_MARKER: &str = "@reasoning-effort=";

/// The efforts Carpe Diem accepts on `reasoning_effort`. The desktop offers
/// only some of them; the proxy forwards any of these so a newer frontend
/// does not need a newer shell.
const REASONING_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

pub(super) fn provider_models_body(
    model: String,
    context_tokens: Option<i64>,
) -> serde_json::Value {
    let mut entry = serde_json::json!({
        "id": model,
        "object": "model",
        "created": 0,
        "owned_by": "june"
    });
    if let Some(context_tokens) = context_tokens {
        entry["context_length"] = serde_json::json!(context_tokens);
    }
    serde_json::json!({ "object": "list", "data": [entry] })
}

/// Turns `model@reasoning-effort=<level>` back into `model` and sets the flat
/// `reasoning_effort` field, which Carpe Diem reads ahead of `reasoning.effort`.
///
/// The pinned Hermes never sends a reasoning field to a loopback provider, and
/// the proxy is shared by every session of a process, so the model name is the
/// only per-session channel there is. Stripping happens here, before the body
/// reaches the sidecar, so the egress ledger, the price table and the cache
/// statistics all see the real id. An unknown level is stripped and dropped:
/// a malformed alias still runs the turn, on the provider's default effort.
pub(super) fn apply_reasoning_effort_alias(body: &mut serde_json::Value) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let Some(model) = object.get("model").and_then(serde_json::Value::as_str) else {
        return;
    };
    let Some(index) = model.rfind(REASONING_EFFORT_ALIAS_MARKER) else {
        return;
    };
    if index == 0 {
        return;
    }
    let effort = model[index + REASONING_EFFORT_ALIAS_MARKER.len()..]
        .trim()
        .to_string();
    let bare = model[..index].to_string();
    object.insert("model".to_string(), serde_json::Value::String(bare));
    if REASONING_EFFORTS.contains(&effort.as_str()) {
        object.insert(
            "reasoning_effort".to_string(),
            serde_json::Value::String(effort),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_listing_advertises_the_context_window_when_known() {
        let body = provider_models_body("zai-org-glm-5".to_string(), Some(202_752));

        let entry = &body["data"][0];
        assert_eq!(entry["id"], "zai-org-glm-5");
        // The key hermes-agent's _CONTEXT_LENGTH_KEYS reads; renaming it
        // silently puts the agent back on reactive overflow recovery.
        assert_eq!(entry["context_length"], 202_752);
    }

    #[test]
    fn models_listing_omits_the_context_window_when_unknown() {
        // Offline or signed out: the listing must still serve (hermes needs
        // it to enumerate the model at all) and just skip the window, which
        // returns hermes to its own probing.
        let body = provider_models_body("zai-org-glm-5".to_string(), None);

        let entry = &body["data"][0];
        assert_eq!(entry["id"], "zai-org-glm-5");
        assert!(entry.get("context_length").is_none());
    }

    #[test]
    fn an_effort_alias_becomes_the_real_model_and_a_flat_reasoning_effort() {
        let mut body = serde_json::json!({
            "model": "zai-org-glm-5-2@reasoning-effort=high",
            "messages": [{ "role": "user", "content": "hi" }],
            "stream": true,
        });

        apply_reasoning_effort_alias(&mut body);

        assert_eq!(body["model"], "zai-org-glm-5-2");
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["content"], "hi");
    }

    #[test]
    fn the_alias_overrides_an_effort_the_runtime_may_have_sent() {
        let mut body = serde_json::json!({
            "model": "kimi-k2-6@reasoning-effort=low",
            "reasoning_effort": "medium",
        });

        apply_reasoning_effort_alias(&mut body);

        assert_eq!(body["model"], "kimi-k2-6");
        assert_eq!(body["reasoning_effort"], "low");
    }

    #[test]
    fn a_plain_model_is_left_alone() {
        let mut body = serde_json::json!({ "model": "zai-org-glm-5-2", "max_tokens": 10 });
        let before = body.clone();

        apply_reasoning_effort_alias(&mut body);

        assert_eq!(body, before);
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn an_unknown_effort_is_stripped_but_never_forwarded() {
        let mut body = serde_json::json!({ "model": "zai-org-glm-5-2@reasoning-effort=turbo" });

        apply_reasoning_effort_alias(&mut body);

        assert_eq!(body["model"], "zai-org-glm-5-2");
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn a_body_without_a_model_or_a_bare_marker_is_untouched() {
        let mut missing = serde_json::json!({ "messages": [] });
        apply_reasoning_effort_alias(&mut missing);
        assert_eq!(missing, serde_json::json!({ "messages": [] }));

        // A marker with nothing before it names no model: forwarding it as is
        // lets the sidecar refuse it, instead of inventing an empty id.
        let mut bare = serde_json::json!({ "model": "@reasoning-effort=high" });
        apply_reasoning_effort_alias(&mut bare);
        assert_eq!(bare["model"], "@reasoning-effort=high");
        assert!(bare.get("reasoning_effort").is_none());
    }
}
