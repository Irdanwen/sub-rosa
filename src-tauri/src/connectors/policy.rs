//! What a connector tool may do without asking: allow, ask or deny, per tool,
//! with the same three choices the desktop's MCP security page explains.
//!
//! A tool the person has not ruled on follows its server's own hint: one that
//! says it only reads runs, anything else asks first. The hint chooses the
//! default and nothing more; the person's rule always wins, and nothing here
//! ever loosens a rule on the server's say-so.

use std::collections::BTreeMap;

use super::mcp::ToolInfo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Allow,
    Ask,
    Deny,
}

impl Rule {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "allow" => Some(Self::Allow),
            "ask" => Some(Self::Ask),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }
}

pub fn default_rule(tool: &ToolInfo) -> Rule {
    if tool.read_only {
        Rule::Allow
    } else {
        Rule::Ask
    }
}

pub fn parse_policy(raw: &str) -> BTreeMap<String, String> {
    serde_json::from_str(raw).unwrap_or_default()
}

pub fn effective(policy: &BTreeMap<String, String>, tool: &ToolInfo) -> Rule {
    policy
        .get(&tool.name)
        .and_then(|rule| Rule::parse(rule))
        .unwrap_or_else(|| default_rule(tool))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, read_only: bool) -> ToolInfo {
        ToolInfo {
            name: name.into(),
            title: None,
            description: String::new(),
            input_schema: serde_json::json!({"type": "object"}),
            read_only,
            destructive: !read_only,
            ui_resource: None,
        }
    }

    #[test]
    fn reading_runs_and_anything_else_asks_by_default() {
        let policy = BTreeMap::new();
        assert_eq!(effective(&policy, &tool("search", true)), Rule::Allow);
        assert_eq!(effective(&policy, &tool("create_issue", false)), Rule::Ask);
    }

    #[test]
    fn the_persons_rule_wins_over_the_hint() {
        let mut policy = BTreeMap::new();
        policy.insert("search".to_string(), "deny".to_string());
        policy.insert("create_issue".to_string(), "allow".to_string());
        policy.insert("odd".to_string(), "sometimes".to_string());
        assert_eq!(effective(&policy, &tool("search", true)), Rule::Deny);
        assert_eq!(
            effective(&policy, &tool("create_issue", false)),
            Rule::Allow
        );
        // An unreadable rule is no rule: the default applies.
        assert_eq!(effective(&policy, &tool("odd", false)), Rule::Ask);
    }
}
