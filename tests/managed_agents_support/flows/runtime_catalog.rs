use super::{request_json, AppFixture};

pub async fn assert_agent_runtime_catalog(fixture: &AppFixture) {
    let response = request_json(fixture.app.clone(), "GET", "/api/agent-runtimes", None).await;
    let runtimes = response["runtimes"].as_array().unwrap();
    let ids: Vec<_> = runtimes
        .iter()
        .map(|runtime| runtime["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![
            "claude_managed_agents",
            "cursor",
            "gemini_antigravity",
            "elastic_agent_builder"
        ]
    );
    assert_eq!(
        runtime(runtimes, "claude_managed_agents")["credential_provider_id"],
        "anthropic"
    );
    assert_eq!(
        runtime(runtimes, "cursor")["credential_provider_id"],
        "cursor"
    );
    assert_eq!(
        runtime(runtimes, "gemini_antigravity")["credential_provider_id"],
        "gemini"
    );
    assert_eq!(
        runtime(runtimes, "elastic_agent_builder")["credential_provider_id"],
        "elastic"
    );
    assert_eq!(
        runtime(runtimes, "gemini_antigravity")["default_api_base"],
        "https://generativelanguage.googleapis.com"
    );
    assert_runtime_tools(runtimes);
}

fn runtime<'a>(runtimes: &'a [serde_json::Value], id: &str) -> &'a serde_json::Value {
    runtimes.iter().find(|runtime| runtime["id"] == id).unwrap()
}

fn assert_runtime_tools(runtimes: &[serde_json::Value]) {
    let claude_tools: Vec<_> = runtime(runtimes, "claude_managed_agents")["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        claude_tools,
        vec![
            "bash",
            "read",
            "write",
            "edit",
            "glob",
            "grep",
            "web_fetch",
            "web_search"
        ]
    );
    let gemini_tools: Vec<_> = runtime(runtimes, "gemini_antigravity")["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        gemini_tools,
        vec!["code_execution", "google_search", "url_context"]
    );
}
