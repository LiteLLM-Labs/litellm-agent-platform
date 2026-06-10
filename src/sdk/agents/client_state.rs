use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde_json::Value;

use super::{AgentRuntime, AgentSdkError, SessionContext};

#[derive(Default)]
pub(super) struct ClientState {
    session_contexts: Mutex<HashMap<String, SessionContext>>,
    cursor_run_ids: Mutex<HashMap<String, String>>,
    pending_turns: Mutex<HashMap<String, String>>,
    agent_meta: Mutex<HashMap<String, Value>>,
}

impl ClientState {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub(super) fn context_for_session(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionContext>, AgentSdkError> {
        Ok(self
            .session_contexts
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .get(session_id)
            .cloned())
    }

    pub(super) fn runtime_for_session(
        &self,
        session_id: &str,
    ) -> Result<Option<AgentRuntime>, AgentSdkError> {
        Ok(self
            .session_contexts
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .get(session_id)
            .map(|context| context.runtime))
    }

    pub(super) fn remember_cursor_run(
        &self,
        agent_id: &str,
        run_id: &str,
    ) -> Result<(), AgentSdkError> {
        self.cursor_run_ids
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .insert(agent_id.to_owned(), run_id.to_owned());
        Ok(())
    }

    pub(super) fn cursor_run_for_agent(
        &self,
        agent_id: &str,
    ) -> Result<Option<String>, AgentSdkError> {
        Ok(self
            .cursor_run_ids
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .get(agent_id)
            .cloned())
    }

    pub(super) fn remember_pending_turn(
        &self,
        session_id: &str,
        prompt: &str,
    ) -> Result<(), AgentSdkError> {
        self.pending_turns
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .insert(session_id.to_owned(), prompt.to_owned());
        Ok(())
    }

    pub(super) fn take_pending_turn(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, AgentSdkError> {
        Ok(self
            .pending_turns
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .remove(session_id))
    }

    pub(super) fn remember_agent_meta(
        &self,
        agent_id: &str,
        meta: Value,
    ) -> Result<(), AgentSdkError> {
        self.agent_meta
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .insert(agent_id.to_owned(), meta);
        Ok(())
    }

    pub(super) fn agent_meta(&self, agent_id: &str) -> Result<Option<Value>, AgentSdkError> {
        Ok(self
            .agent_meta
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .get(agent_id)
            .cloned())
    }

    pub(super) fn remember_session_context(
        &self,
        session_id: &str,
        context: SessionContext,
    ) -> Result<(), AgentSdkError> {
        self.session_contexts
            .lock()
            .map_err(|_| AgentSdkError::StateLock)?
            .insert(session_id.to_owned(), context);
        Ok(())
    }
}
