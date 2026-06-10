use serde_json::{json, Value};

use crate::{errors::GatewayError, sdk::routing::Deployment};

use super::message_content::{openai_output_text, openai_usage, parsed_openai_response};

pub(super) fn anthropic_messages_to_openai_responses(
    body: Value,
    deployment: &Deployment,
) -> Value {
    let mut request = serde_json::Map::new();
    request.insert(
        "model".to_owned(),
        Value::String(deployment.upstream_model.clone()),
    );
    request.insert("input".to_owned(), anthropic_input(&body));
    if let Some(max_tokens) = body.get("max_tokens").cloned() {
        request.insert("max_output_tokens".to_owned(), max_tokens);
    }
    for key in ["stream", "temperature", "top_p"] {
        if let Some(value) = body.get(key).cloned() {
            request.insert(key.to_owned(), value);
        }
    }
    if let Some(stop) = body
        .get("stop_sequences")
        .cloned()
        .or_else(|| body.get("stop").cloned())
    {
        request.insert("stop".to_owned(), stop);
    }
    Value::Object(request)
}

fn anthropic_input(body: &Value) -> Value {
    let mut input = Vec::new();
    push_system_input(&mut input, body);
    push_message_inputs(&mut input, body);
    if input.is_empty() {
        return Value::String(String::new());
    }
    Value::Array(input)
}

fn push_system_input(input: &mut Vec<Value>, body: &Value) {
    if let Some(system) = body.get("system") {
        let text = anthropic_content_text(system);
        if !text.is_empty() {
            input.push(json!({ "role": "system", "content": text }));
        }
    }
}

fn push_message_inputs(input: &mut Vec<Value>, body: &Value) {
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            let Some(role) = message.get("role").and_then(Value::as_str) else {
                continue;
            };
            let text = anthropic_content_text(message.get("content").unwrap_or(&Value::Null));
            if !text.is_empty() {
                input.push(json!({ "role": role, "content": text }));
            }
        }
    }
}

fn anthropic_content_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text.as_str()),
                Value::Object(map) => map.get("text").and_then(Value::as_str),
                _ => None,
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => map
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    }
}

pub(super) fn openai_response_to_anthropic_message(
    raw: &Value,
    deployment: &Deployment,
) -> Value {
    let (input_tokens, output_tokens) = openai_usage(raw);
    json!({
        "id": raw.get("id").and_then(Value::as_str).unwrap_or("msg_openai_response"),
        "type": "message",
        "role": "assistant",
        "model": raw
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(deployment.upstream_model.as_str()),
        "content": [{
            "type": "text",
            "text": openai_output_text(raw)
        }],
        "stop_reason": "end_turn",
        "stop_sequence": null,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens
        }
    })
}

pub(super) fn openai_response_to_anthropic_sse(
    body: &[u8],
    content_type: Option<&str>,
    deployment: &Deployment,
) -> Result<String, GatewayError> {
    let parsed = parsed_openai_response(body, content_type)?;
    let start = anthropic_message_start(&parsed.response, deployment);
    let (input_tokens, output_tokens) = openai_usage(&parsed.response);
    let mut out = String::new();
    push_sse(&mut out, "message_start", start);
    push_sse(&mut out, "content_block_start", text_block_start());
    if !parsed.text.is_empty() {
        push_sse(&mut out, "content_block_delta", text_delta(parsed.text));
    }
    push_sse(&mut out, "content_block_stop", json!({
        "type": "content_block_stop",
        "index": 0
    }));
    push_sse(&mut out, "message_delta", json!({
        "type": "message_delta",
        "delta": {
            "stop_reason": "end_turn",
            "stop_sequence": null
        },
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens
        }
    }));
    push_sse(&mut out, "message_stop", json!({ "type": "message_stop" }));
    Ok(out)
}

fn anthropic_message_start(raw: &Value, deployment: &Deployment) -> Value {
    let (input_tokens, _) = openai_usage(raw);
    json!({
        "type": "message_start",
        "message": {
            "id": raw
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("msg_openai_response"),
            "type": "message",
            "role": "assistant",
            "model": raw
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or(deployment.upstream_model.as_str()),
            "content": [],
            "stop_reason": null,
            "stop_sequence": null,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": 0
            }
        }
    })
}

fn text_block_start() -> Value {
    json!({
        "type": "content_block_start",
        "index": 0,
        "content_block": {
            "type": "text",
            "text": ""
        }
    })
}

fn text_delta(text: String) -> Value {
    json!({
        "type": "content_block_delta",
        "index": 0,
        "delta": {
            "type": "text_delta",
            "text": text
        }
    })
}

fn push_sse(out: &mut String, event: &str, data: Value) {
    out.push_str("event: ");
    out.push_str(event);
    out.push_str("\ndata: ");
    out.push_str(&data.to_string());
    out.push_str("\n\n");
}
