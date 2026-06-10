use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use reqwest::{header, Method};
use serde::Serialize;
use serde_json::Value;

use super::{
    events::{stream_events, AgentEventStream},
    resources::Beta,
    responses::{ensure_success, response_json},
    runtime_config::{configured_http_client, runtime_configs, RuntimeConfig},
    session_context::SessionContext,
    types::{AgentRuntime, AgentSdkError, LapConfig, ManagedSessionRef},
};
use crate::sdk::{providers, providers::base::runtime::RuntimeAdapter};

#[derive(Clone)]
pub struct Lap {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    runtimes: HashMap<AgentRuntime, RuntimeConfig>,
    session_contexts: Mutex<HashMap<String, SessionContext>>,
    cursor_run_ids: Mutex<HashMap<String, String>>,
    /// Generic per-session prompt stash for runtimes whose provider call is
    /// deferred to the streaming phase (e.g. Elastic Agent Builder).
    pending_turns: Mutex<HashMap<String, String>>,
    /// Generic per-agent provider metadata stash, captured at agent-bind time
    /// and consumed when the session is created within the same client.
    agent_meta: Mutex<HashMap<String, Value>>,
    elastic_default_agent_id: Option<String>,
}

impl Lap {
    pub fn new(config: LapConfig) -> Self {
        let default = config.elastic_default_agent_id.clone();
        Self::with_http(configured_http_client(), runtime_configs(config), default)
    }

    pub(crate) fn with_http_client(config: LapConfig, http: reqwest::Client) -> Self {
        let default = config.elastic_default_agent_id.clone();
        Self::with_http(http, runtime_configs(config), default)
    }

    pub fn register_session(&self, session: ManagedSessionRef) -> Result<(), AgentSdkError> {
        let session_id = session.session_id.clone();
        let context = self
            .adapter(session.lap_agent_runtime)?
            .session_context(session);
        self.remember_session_context(&session_id, context)
    }

    fn with_http(
        http: reqwest::Client,
        runtimes: HashMap<AgentRuntime, RuntimeConfig>,
        elastic_default_agent_id: Option<String>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                http,
                runtimes,
                session_contexts: Mutex::new(HashMap::new()),
                cursor_run_ids: Mutex::new(HashMap::new()),
                pending_turns: Mutex::new(HashMap::new()),
                agent_meta: Mutex::new(HashMap::new()),
                elastic_default_agent_id,
            }),
        }
    }

    pub fn beta(&self) -> Beta<'_> {
        Beta { client: self }
    }

    pub(crate) async fn post<T: Serialize>(
        &self,
        runtime: AgentRuntime,
        path: &str,
        body: &T,
    ) -> Result<Value, AgentSdkError> {
        let response = self
            .request(runtime, Method::POST, path)?
            .json(body)
            .send()
            .await?;
        response_json(response).await
    }

    pub(crate) async fn get(
        &self,
        runtime: AgentRuntime,
        path: &str,
    ) -> Result<Value, AgentSdkError> {
        let response = self.request(runtime, Method::GET, path)?.send().await?;
        response_json(response).await
    }

    pub(crate) async fn delete(
        &self,
        runtime: AgentRuntime,
        path: &str,
    ) -> Result<Value, AgentSdkError> {
        let response = self.request(runtime, Method::DELETE, path)?.send().await?;
        response_json(response).await
    }

    pub(crate) async fn stream(
        &self,
        runtime: AgentRuntime,
        path: &str,
    ) -> Result<AgentEventStream, AgentSdkError> {
        let response = self
            .request(runtime, Method::GET, path)?
            .header(header::ACCEPT, "text/event-stream")
            .send()
            .await?;
        let stream = stream_events(ensure_success(response).await?);
        Ok(self.adapter(runtime)?.normalize_stream(stream))
    }

    /// Open an SSE stream over a `POST` request. Elastic's streaming converse
    /// path (`POST /api/agent_builder/converse/async`) requires a request body,
    /// unlike the `GET`-based streams used by other runtimes.
    pub(crate) async fn stream_post<T: Serialize>(
        &self,
        runtime: AgentRuntime,
        path: &str,
        body: &T,
    ) -> Result<AgentEventStream, AgentSdkError> {
        let response = self
            .request(runtime, Method::POST, path)?
            .header(header::ACCEPT, "text/event-stream")
            .json(body)
            .send()
            .await?;
        let stream = stream_events(ensure_success(response).await?);
        Ok(self.adapter(runtime)?.normalize_stream(stream))
    }

    pub(crate) fn request(
        &self,
        runtime: AgentRuntime,
        method: Method,
        path: &str,
    ) -> Result<reqwest::RequestBuilder, AgentSdkError> {
        let config = self
            .inner
            .runtimes
            .get(&runtime)
            .ok_or(AgentSdkError::RuntimeNotConfigured(runtime))?;
        let request = self
            .inner
            .http
            .request(method, format!("{}{}", config.base_url, path))
            .header(header::CONTENT_TYPE, "application/json");
        Ok(config.authorize(request))
    }

    pub(super) fn adapter(
        &self,
        runtime: AgentRuntime,
    ) -> Result<Arc<dyn RuntimeAdapter>, AgentSdkError> {
        providers::adapter(runtime).ok_or(AgentSdkError::RuntimeNotConfigured(runtime))
    }

    pub(super) fn default_runtime(&self) -> Result<AgentRuntime, AgentSdkError> {
        if self.inner.runtimes.len() == 1 {
            self.inner
                .runtimes
                .keys()
                .copied()
                .next()
                .ok_or(AgentSdkError::NoRuntimesConfigured)
        } else if self.inner.runtimes.is_empty() {
            Err(AgentSdkError::NoRuntimesConfigured)
        } else {
            Err(AgentSdkError::RuntimeRequired)
        }
    }

    pub(super) fn runtime_for_session(
        &self,
        session_id: &str,
    ) -> Result<AgentRuntime, AgentSdkError> {
        let contexts = self
            .inner
            .session_contexts
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?;
        contexts
            .get(session_id)
            .map(|context| context.runtime)
            .map(Ok)
            .unwrap_or_else(|| self.default_runtime())
    }

    pub(crate) fn context_for_session(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionContext>, AgentSdkError> {
        let contexts = self
            .inner
            .session_contexts
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?;
        Ok(contexts.get(session_id).cloned())
    }

    pub(crate) fn remember_cursor_run(
        &self,
        agent_id: &str,
        run_id: &str,
    ) -> Result<(), AgentSdkError> {
        self.inner
            .cursor_run_ids
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .insert(agent_id.to_owned(), run_id.to_owned());
        Ok(())
    }

    pub(crate) fn cursor_run_for_agent(
        &self,
        agent_id: &str,
    ) -> Result<Option<String>, AgentSdkError> {
        Ok(self
            .inner
            .cursor_run_ids
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .get(agent_id)
            .cloned())
    }

    pub(crate) fn elastic_default_agent_id(&self) -> Option<String> {
        self.inner.elastic_default_agent_id.clone()
    }

    pub(crate) fn remember_pending_turn(
        &self,
        session_id: &str,
        prompt: &str,
    ) -> Result<(), AgentSdkError> {
        self.inner
            .pending_turns
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .insert(session_id.to_owned(), prompt.to_owned());
        Ok(())
    }

    pub(crate) fn take_pending_turn(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, AgentSdkError> {
        Ok(self
            .inner
            .pending_turns
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .remove(session_id))
    }

    pub(crate) fn remember_agent_meta(
        &self,
        agent_id: &str,
        meta: Value,
    ) -> Result<(), AgentSdkError> {
        self.inner
            .agent_meta
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .insert(agent_id.to_owned(), meta);
        Ok(())
    }

    pub(crate) fn agent_meta(&self, agent_id: &str) -> Result<Option<Value>, AgentSdkError> {
        Ok(self
            .inner
            .agent_meta
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .get(agent_id)
            .cloned())
    }

    pub(crate) fn remember_session_context(
        &self,
        session_id: &str,
        context: SessionContext,
    ) -> Result<(), AgentSdkError> {
        self.inner
            .session_contexts
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .insert(session_id.to_owned(), context);
        Ok(())
    }

    pub(crate) fn remember_session(
        &self,
        session_id: &str,
        runtime: AgentRuntime,
    ) -> Result<(), AgentSdkError> {
        self.remember_session_context(
            session_id,
            SessionContext {
                runtime,
                provider_session_id: Some(session_id.to_owned()),
                agent_id: None,
                run_id: None,
            },
        )
    }
}
