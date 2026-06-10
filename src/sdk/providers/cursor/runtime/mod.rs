use std::time::{Duration, Instant};

use reqwest::StatusCode;
use serde_json::{json, Value};

mod helpers;
mod request_body;
mod stream;

use crate::sdk::agents::{
    response_fields::{id, nested_id, nested_string_field},
    AgentEventStream, AgentRuntime, AgentSdkError, CreateAgentParams,
    CreateEnvironmentParams, CreateSessionParams, Environment, Lap, ManagedAgent,
    ManagedSessionRef, SendEventsParams, SendEventsResponse, Session, SessionContext,
};
use crate::sdk::providers::base::runtime::{AdapterFuture, RuntimeAdapter};
use helpers::{
    agent_id_from_context, cursor_agent_id, latest_run_id, prompt_from_events, run_id,
};
use request_body::create_agent_body;
use stream::normalize_cursor_stream;

/// String ID used to identify this runtime in the database and HTTP API.
pub(crate) const RUNTIME_ID: &str = "cursor";

pub(crate) struct CursorRuntime;

impl RuntimeAdapter for CursorRuntime {
    fn normalize_stream(&self, stream: AgentEventStream) -> AgentEventStream {
        normalize_cursor_stream(stream)
    }

    fn session_context(&self, session: ManagedSessionRef) -> SessionContext {
        SessionContext {
            runtime: session.lap_agent_runtime,
            provider_session_id: session.provider_session_id.clone(),
            agent_id: session.provider_agent_id.or(session.provider_session_id),
            run_id: session.provider_run_id,
        }
    }

    fn provider_run_id_from_agent_raw(&self, raw: &Value) -> Option<String> {
        raw.get("run")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .or_else(|| {
                raw.get("agent")
                    .and_then(|a| a.get("latestRunId"))
                    .and_then(Value::as_str)
            })
            .or_else(|| raw.get("latestRunId").and_then(Value::as_str))
            .map(str::to_owned)
    }

    fn provider_url_from_agent_raw(&self, raw: &Value) -> Option<String> {
        raw.get("url")
            .and_then(Value::as_str)
            .or_else(|| raw.get("webUrl").and_then(Value::as_str))
            .or_else(|| raw.get("agent").and_then(|a| a.get("url")).and_then(Value::as_str))
            .or_else(|| raw.get("agent").and_then(|a| a.get("webUrl")).and_then(Value::as_str))
            .map(str::to_owned)
    }

    fn provider_agent_id_from_session_id(&self, provider_session_id: &str) -> Option<String> {
        Some(provider_session_id.to_owned())
    }

    fn create_agent<'a>(
        &'a self,
        client: &'a Lap,
        params: CreateAgentParams,
    ) -> AdapterFuture<'a, ManagedAgent> {
        Box::pin(async move {
            let raw = client
                .post(
                    AgentRuntime::Cursor,
                    "/v1/agents",
                    &create_agent_body(params),
                )
                .await?;
            let agent_id = nested_id(&raw, "agent").or_else(|_| id(&raw))?;
            if let Some(run_id) = run_id(&raw) {
                client.remember_cursor_run(&agent_id, &run_id)?;
            }
            Ok(ManagedAgent {
                id: agent_id,
                version: None,
                name: raw.get("agent").and_then(|a| a.get("name")).and_then(Value::as_str)
                    .or_else(|| raw.get("name").and_then(Value::as_str))
                    .map(str::to_owned),
                description: None,
                model: None,
                system: None,
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
                    "cursor sessions.create requires a non-empty Cursor agent id".to_owned(),
                ));
            }
            let raw = json!({ "id": params.agent });
            let session = Session {
                id: id(&raw)?,
                agent: None,
                environment_id: None,
                status: None,
                metadata: None,
                created_at: None,
                updated_at: None,
                raw,
            };
            let run_id = client.cursor_run_for_agent(&session.id)?;
            client.remember_session_context(
                &session.id,
                SessionContext::cursor(session.id.clone(), run_id),
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
        self.send_events_with_model(client, session_id, None, params)
    }

    fn send_events_with_model<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
        model: Option<String>,
        params: SendEventsParams,
    ) -> AdapterFuture<'a, SendEventsResponse> {
        Box::pin(async move {
            let agent_id = cursor_agent_id(client, session_id)?;
            let mut body = serde_json::Map::from_iter([(
                "prompt".to_owned(),
                prompt_from_events(&params.events)?,
            )]);
            if let Some(model) = model {
                body.insert("model".to_owned(), Value::String(model));
            }
            let body = Value::Object(body);
            let deadline = Instant::now() + Duration::from_secs(300);
            let mut delay = Duration::from_millis(500);
            loop {
                let result = client
                    .post(AgentRuntime::Cursor, &format!("/v1/agents/{agent_id}/runs"), &body)
                    .await;
                match result {
                    Ok(raw) => {
                        let run_id = nested_string_field(&raw, "run", "id")?;
                        client.remember_session_context(
                            session_id,
                            SessionContext::cursor(agent_id, Some(run_id)),
                        )?;
                        return Ok(SendEventsResponse { raw });
                    }
                    Err(e) => {
                        let agent_busy = matches!(
                            &e,
                            AgentSdkError::Provider { status, body }
                                if *status == StatusCode::CONFLICT && body.contains("agent_busy")
                        );
                        if agent_busy && Instant::now() < deadline {
                            tokio::time::sleep(delay).await;
                            delay = (delay * 2).min(Duration::from_secs(10));
                        } else {
                            return Err(e);
                        }
                    }
                }
            }
        })
    }

    fn stream_events<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
    ) -> AdapterFuture<'a, AgentEventStream> {
        Box::pin(async move {
            let context = client.context_for_session(session_id)?;
            let agent_id = agent_id_from_context(session_id, context.as_ref());
            let run_id = match context.and_then(|context| context.run_id) {
                Some(run_id) => run_id,
                None => latest_run_id(client, &agent_id).await?,
            };
            client
                .stream(
                    AgentRuntime::Cursor,
                    &format!("/v1/agents/{agent_id}/runs/{run_id}/stream"),
                )
                .await
        })
    }

    fn interrupt_session<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
    ) -> AdapterFuture<'a, ()> {
        Box::pin(async move {
            let context = client.context_for_session(session_id)?;
            let agent_id = agent_id_from_context(session_id, context.as_ref());
            let run_id = match context.and_then(|context| context.run_id) {
                Some(run_id) => run_id,
                None => latest_run_id(client, &agent_id).await?,
            };
            client
                .post(
                    AgentRuntime::Cursor,
                    &format!("/v1/agents/{agent_id}/runs/{run_id}/cancel"),
                    &serde_json::json!({}),
                )
                .await?;
            Ok(())
        })
    }
}
