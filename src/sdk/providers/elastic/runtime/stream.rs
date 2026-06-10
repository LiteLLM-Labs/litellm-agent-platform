use async_stream::try_stream;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};

use crate::sdk::agents::{AgentEvent, AgentEventStream};

/// Normalize the Kibana Agent Builder SSE stream into LAP runtime events,
/// capturing the Elastic `conversation_id` so it can be persisted for the next
/// turn. The captured ID is attached to emitted events as `provider_run_id`.
pub(super) fn normalize_elastic_stream(mut stream: AgentEventStream) -> AgentEventStream {
    let stream = try_stream! {
        let mut state = ElasticStreamState::default();
        while let Some(event) = stream.next().await {
            for event in state.normalize(event?) {
                yield event;
            }
        }
        for event in state.finish() {
            yield event;
        }
    };
    Box::pin(stream)
}

#[derive(Default)]
struct ElasticStreamState {
    assistant_text: String,
    conversation_id: Option<String>,
    emitted_running: bool,
    closed: bool,
}

impl ElasticStreamState {
    fn normalize(&mut self, event: AgentEvent) -> Vec<AgentEvent> {
        self.capture_conversation_id(&event.data);
        let mut events = Vec::new();
        if !self.emitted_running {
            self.emitted_running = true;
            events.push(self.decorate(simple_event("session.status_running", Map::new())));
        }
        match event.event_type.as_str() {
            "message_chunk" | "text_chunk" | "chunk" => {
                if let Some(text) = chunk_text(&event.data) {
                    self.assistant_text.push_str(&text);
                }
            }
            "message_complete" | "message" | "assistant_message" => {
                if let Some(text) = complete_message_text(&event.data) {
                    self.assistant_text = text;
                }
                events.extend(self.flush_message());
            }
            "reasoning" | "thinking" | "progress" | "agent_progress" => {
                events.push(self.decorate(simple_event("agent.thinking", Map::new())));
            }
            "tool_call" | "tool_use" => {
                events.extend(self.flush_message());
                events.push(self.decorate(tool_use_event(&event.data)));
            }
            "tool_result" => {
                if let Some(event) = tool_result_event(&event.data) {
                    events.push(self.decorate(event));
                }
            }
            "round_complete" | "complete" | "done" => {
                events.extend(self.flush_message());
                events.push(self.decorate(simple_event("session.status_idle", idle_data())));
                self.closed = true;
            }
            "error" => {
                events.extend(self.flush_message());
                events.push(self.decorate(simple_event("session.error", error_data(&event.data))));
                self.closed = true;
            }
            // conversation_created / conversation_updated / ping — already
            // mined for the conversation ID above; nothing else to emit.
            _ => {}
        }
        events
    }

    fn finish(&mut self) -> Vec<AgentEvent> {
        let mut events = self.flush_message();
        if !self.closed {
            events.push(self.decorate(simple_event("session.status_idle", idle_data())));
            self.closed = true;
        }
        events
    }

    fn flush_message(&mut self) -> Vec<AgentEvent> {
        if self.assistant_text.is_empty() {
            return Vec::new();
        }
        let text = std::mem::take(&mut self.assistant_text);
        vec![self.decorate(agent_message_event(text))]
    }

    fn capture_conversation_id(&mut self, data: &Map<String, Value>) {
        if self.conversation_id.is_some() {
            return;
        }
        if let Some(id) = find_conversation_id(data) {
            self.conversation_id = Some(id);
        }
    }

    /// Attach the captured Elastic `conversation_id` so the shared runtime
    /// drain can persist it as the session's `provider_run_id`.
    fn decorate(&self, mut event: AgentEvent) -> AgentEvent {
        if let Some(conversation_id) = &self.conversation_id {
            event
                .data
                .entry("provider_run_id".to_owned())
                .or_insert_with(|| Value::String(conversation_id.clone()));
        }
        event
    }
}

/// Search an event payload (top-level and one nested `data` level) for an
/// Elastic conversation identifier.
fn find_conversation_id(data: &Map<String, Value>) -> Option<String> {
    for key in ["conversation_id", "conversationId"] {
        if let Some(id) = data.get(key).and_then(Value::as_str) {
            if !id.is_empty() {
                return Some(id.to_owned());
            }
        }
    }
    if let Some(nested) = data.get("data").and_then(Value::as_object) {
        return find_conversation_id(nested);
    }
    if let Some(conversation) = data.get("conversation").and_then(Value::as_object) {
        return conversation
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
    }
    None
}

fn chunk_text(data: &Map<String, Value>) -> Option<String> {
    for key in ["text_chunk", "text", "content", "delta"] {
        if let Some(text) = data.get(key).and_then(Value::as_str) {
            return Some(text.to_owned());
        }
    }
    if let Some(nested) = data.get("data").and_then(Value::as_object) {
        return chunk_text(nested);
    }
    None
}

fn complete_message_text(data: &Map<String, Value>) -> Option<String> {
    for key in ["message_content", "content", "text"] {
        if let Some(text) = data.get(key).and_then(Value::as_str) {
            return Some(text.to_owned());
        }
    }
    if let Some(message) = data.get("message").and_then(Value::as_object) {
        if let Some(text) = message.get("content").and_then(Value::as_str) {
            return Some(text.to_owned());
        }
    }
    if let Some(nested) = data.get("data").and_then(Value::as_object) {
        return complete_message_text(nested);
    }
    None
}

fn tool_use_event(data: &Map<String, Value>) -> AgentEvent {
    let source = nested(data);
    let mut out = Map::new();
    if let Some(id) = string_any(&source, &["tool_call_id", "toolCallId", "id"]) {
        out.insert("id".to_owned(), Value::String(id));
    }
    if let Some(name) = string_any(&source, &["tool_id", "toolId", "tool", "name"]) {
        out.insert("name".to_owned(), Value::String(name));
    }
    let input = source
        .get("params")
        .or_else(|| source.get("arguments"))
        .or_else(|| source.get("args"))
        .or_else(|| source.get("input"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    out.insert("input".to_owned(), input);
    simple_event("agent.tool_use", out)
}

fn tool_result_event(data: &Map<String, Value>) -> Option<AgentEvent> {
    let source = nested(data);
    let tool_use_id = string_any(&source, &["tool_call_id", "toolCallId", "id"])?;
    let mut out = Map::new();
    out.insert("tool_use_id".to_owned(), Value::String(tool_use_id));
    let result = source
        .get("results")
        .or_else(|| source.get("result"))
        .or_else(|| source.get("output"))
        .cloned();
    if let Some(result) = result {
        out.insert("content".to_owned(), json!([text_block(result)]));
    }
    Some(simple_event("agent.tool_result", out))
}

/// Some Elastic events wrap their payload under a `data` key; prefer it when present.
fn nested(data: &Map<String, Value>) -> Map<String, Value> {
    data.get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| data.clone())
}

fn string_any(data: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| data.get(*key).and_then(Value::as_str))
        .map(str::to_owned)
}

fn error_data(data: &Map<String, Value>) -> Map<String, Value> {
    let message = data
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .or_else(|| data.get("message").and_then(Value::as_str))
        .unwrap_or("Elastic Agent Builder interaction failed")
        .to_owned();
    let mut out = Map::new();
    out.insert("error".to_owned(), json!({ "message": message }));
    out
}

fn agent_message_event(text: String) -> AgentEvent {
    let mut data = Map::new();
    data.insert(
        "content".to_owned(),
        json!([{ "type": "text", "text": text }]),
    );
    simple_event("agent.message", data)
}

fn text_block(value: Value) -> Value {
    match value {
        Value::String(text) => json!({ "type": "text", "text": text }),
        value => json!({ "type": "text", "text": value.to_string() }),
    }
}

fn idle_data() -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("stop_reason".to_owned(), json!({ "type": "end_turn" }));
    data
}

fn simple_event(event_type: &str, data: Map<String, Value>) -> AgentEvent {
    AgentEvent {
        event_type: event_type.to_owned(),
        data,
    }
}
