use serde_json::{json, Value};

use crate::sdk::agents::{
    response_fields::id, AgentEventStream, AgentRuntime, AgentSdkError, CreateAgentParams,
    CreateEnvironmentParams, CreateSessionParams, Environment, Lap, ManagedAgent, ManagedSessionRef,
    SendEventsParams, SendEventsResponse, Session, SessionContext, ELASTIC_AGENT_BUILDER,
};
use crate::sdk::providers::base::runtime::{AdapterFuture, RuntimeAdapter};

mod request_body;
mod stream;

#[cfg(test)]
mod tests;

use request_body::{pending_send_raw, prompt_from_events, ElasticBinding};
use stream::normalize_elastic_stream;

/// String ID used to identify this runtime in the database and HTTP API.
pub(crate) const RUNTIME_ID: &str = ELASTIC_AGENT_BUILDER;

/// Placeholder `provider_run_id` recorded before Elastic issues a real
/// `conversation_id`; treated as "no conversation yet" when starting a turn.
pub(crate) const PENDING_RUN_MARKER: &str = "elastic_pending";

pub(crate) struct ElasticAgentBuilderRuntime;

impl RuntimeAdapter for ElasticAgentBuilderRuntime {
    fn normalize_stream(&self, stream: AgentEventStream) -> AgentEventStream {
        normalize_elastic_stream(stream)
    }

    fn session_context(&self, session: ManagedSessionRef) -> SessionContext {
        let binding = session
            .provider_session_id
            .clone()
            .unwrap_or_else(|| session.provider_agent_id.clone().unwrap_or_default());
        let agent_id = session
            .provider_agent_id
            .clone()
            .unwrap_or_else(|| ElasticBinding::decode(&binding).agent_id);
        SessionContext::elastic(
            binding,
            agent_id,
            session.provider_run_id.filter(|id| id != PENDING_RUN_MARKER),
        )
    }

    fn provider_agent_id_from_session_id(&self, provider_session_id: &str) -> Option<String> {
        Some(ElasticBinding::decode(provider_session_id).agent_id)
    }

    fn provider_session_id_from_session_raw(&self, raw: &Value) -> Option<String> {
        raw.get("provider_session_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn provider_run_id_from_agent_raw(&self, raw: &Value) -> Option<String> {
        raw.get("provider_run_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// LAP does not create Elastic-native agents in v1; "creating" an agent
    /// binds the LAP agent to an existing Elastic Agent Builder agent ID.
    fn create_agent<'a>(
        &'a self,
        client: &'a Lap,
        params: CreateAgentParams,
    ) -> AdapterFuture<'a, ManagedAgent> {
        Box::pin(async move {
            let binding = ElasticBinding::resolve(
                params.lap_provider_options.as_ref(),
                client.elastic_default_agent_id(),
            )?;
            // Stash the binding so create_session (same client) can encode it
            // into the durable provider_session_id.
            client.remember_agent_meta(
                &binding.agent_id,
                json!({
                    "binding": binding.encode(),
                }),
            )?;
            let raw = json!({ "id": binding.agent_id, "binding": binding.encode() });
            Ok(ManagedAgent {
                id: binding.agent_id,
                version: None,
                name: Some(params.name),
                description: params.description,
                model: None,
                system: Some(params.system),
                tools: Vec::new(),
                mcp_servers: Vec::new(),
                metadata: None,
                created_at: None,
                updated_at: None,
                raw,
            })
        })
    }

    fn create_environment<'a>(
        &'a self,
        _client: &'a Lap,
        params: CreateEnvironmentParams,
    ) -> AdapterFuture<'a, Environment> {
        Box::pin(async move {
            let raw = json!({ "id": params.name });
            Ok(Environment { id: id(&raw)?, raw })
        })
    }

    fn create_session<'a>(
        &'a self,
        client: &'a Lap,
        params: CreateSessionParams,
    ) -> AdapterFuture<'a, Session> {
        Box::pin(async move {
            if params.agent.trim().is_empty() {
                return Err(AgentSdkError::InvalidRequest(
                    "elastic_agent_builder sessions.create requires a bound Elastic agent id"
                        .to_owned(),
                ));
            }
            // Recover the full binding (space/connector) stashed at bind time;
            // fall back to a bare agent id if it is not available.
            let binding = client
                .agent_meta(&params.agent)?
                .and_then(|meta| {
                    meta.get("binding")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| ElasticBinding::decode(&params.agent).encode());
            let session_id = format!("elastic_ses_{}", uuid::Uuid::new_v4().simple());
            let raw = json!({
                "id": session_id,
                "agent": params.agent,
                "provider_session_id": binding,
                "status": "idle",
            });
            let session = Session {
                id: session_id.clone(),
                agent: Some(params.agent.clone()),
                environment_id: None,
                status: Some("idle".to_owned()),
                metadata: None,
                created_at: None,
                updated_at: None,
                raw,
            };
            client.remember_session_context(
                &session_id,
                SessionContext::elastic(binding, params.agent, None),
            )?;
            Ok(session)
        })
    }

    fn send_events<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
        params: SendEventsParams,
    ) -> AdapterFuture<'a, SendEventsResponse> {
        Box::pin(async move {
            let prompt = prompt_from_events(&params.events)?;
            client.remember_pending_turn(session_id, &prompt)?;
            let conversation_id = client
                .context_for_session(session_id)?
                .and_then(|context| context.run_id)
                .filter(|id| id != PENDING_RUN_MARKER);
            Ok(SendEventsResponse {
                raw: pending_send_raw(conversation_id.as_deref()),
            })
        })
    }

    fn stream_events<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
    ) -> AdapterFuture<'a, AgentEventStream> {
        Box::pin(async move {
            let context = client.context_for_session(session_id)?;
            let binding = context
                .as_ref()
                .and_then(|context| context.provider_session_id.clone())
                .map(|encoded| ElasticBinding::decode(&encoded))
                .ok_or_else(|| {
                    AgentSdkError::InvalidRequest(format!(
                        "elastic_agent_builder session {session_id} is missing its Elastic binding"
                    ))
                })?;
            let conversation_id = context
                .and_then(|context| context.run_id)
                .filter(|id| id != PENDING_RUN_MARKER);
            let prompt = client.take_pending_turn(session_id)?.ok_or_else(|| {
                AgentSdkError::InvalidRequest(format!(
                    "elastic_agent_builder session {session_id} has no pending turn to stream"
                ))
            })?;
            let body = binding.converse_body(&prompt, conversation_id.as_deref());
            client
                .stream_post(
                    AgentRuntime::ElasticAgentBuilder,
                    &binding.converse_path(),
                    &body,
                )
                .await
        })
    }
}
