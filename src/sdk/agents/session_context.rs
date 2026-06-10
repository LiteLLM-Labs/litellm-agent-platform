use super::types::AgentRuntime;

#[derive(Debug, Clone)]
pub(crate) struct SessionContext {
    pub(crate) runtime: AgentRuntime,
    pub(crate) provider_session_id: Option<String>,
    pub(crate) agent_id: Option<String>,
    pub(crate) run_id: Option<String>,
}

impl SessionContext {
    pub(crate) fn cursor(agent_id: String, run_id: Option<String>) -> Self {
        Self {
            runtime: AgentRuntime::Cursor,
            provider_session_id: Some(agent_id.clone()),
            agent_id: Some(agent_id),
            run_id,
        }
    }

    pub(crate) fn gemini(
        environment_id: String,
        agent_id: String,
        interaction_id: Option<String>,
    ) -> Self {
        Self {
            runtime: AgentRuntime::GeminiAntigravity,
            provider_session_id: Some(environment_id),
            agent_id: Some(agent_id),
            run_id: interaction_id,
        }
    }

    /// `provider_session_id` carries the encoded Elastic binding
    /// (`agent_id`/`space`/`connector`), `run_id` carries the Elastic
    /// `conversation_id` once a turn has established one.
    pub(crate) fn elastic(
        binding: String,
        agent_id: String,
        conversation_id: Option<String>,
    ) -> Self {
        Self {
            runtime: AgentRuntime::ElasticAgentBuilder,
            provider_session_id: Some(binding),
            agent_id: Some(agent_id),
            run_id: conversation_id,
        }
    }
}
