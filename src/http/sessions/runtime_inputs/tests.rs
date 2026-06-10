use serde_json::json;

use crate::db::managed_agents::registry::schema::ManagedAgentRow;

use super::{integration_mcp_toolsets, session_metadata};

#[test]
fn session_metadata_truncates_long_prompt_values() {
    let agent = ManagedAgentRow {
        id: "agent_1".to_owned(),
        name: "Agent".to_owned(),
        model: "claude-sonnet-4-6".to_owned(),
        system: String::new(),
        tools: json!([]),
        cadence: None,
        interval_seconds: None,
        session_id: String::new(),
        loop_id: None,
        created_at: 0,
        prompt: None,
        cron: None,
        timezone: "UTC".to_owned(),
        vault_keys: json!([]),
        setup_commands: json!([]),
        max_runtime_minutes: 30,
        on_failure: "notify".to_owned(),
        config: json!({}),
        owner_id: Some("owner".to_owned()),
        status: "active".to_owned(),
        description: None,
        harness: "claude-code".to_owned(),
        skill_ids: json!([]),
        rule_ids: json!([]),
    };
    let metadata = session_metadata(&agent, "ses_1", &"x".repeat(600));
    assert_eq!(metadata["initial_prompt"].chars().count(), 512);
}

#[test]
fn integration_mcp_toolsets_default_to_always_allow() {
    let toolsets = integration_mcp_toolsets(&json!({
        "mcp_servers": [{ "name": "gmail", "type": "url", "url": "https://gateway.example.com/gmail/mcp" }],
        "tools": [{ "type": "mcp_toolset", "mcp_server_name": "gmail" }]
    }));

    assert_eq!(
        toolsets,
        vec![json!({
            "type": "mcp_toolset",
            "mcp_server_name": "gmail",
            "default_config": {
                "enabled": true,
                "permission_policy": { "type": "always_allow" }
            }
        })]
    );
}
