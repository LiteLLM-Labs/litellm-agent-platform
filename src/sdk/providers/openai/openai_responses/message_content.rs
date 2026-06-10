use serde_json::Value;

use crate::errors::GatewayError;

pub(super) struct ParsedOpenAiResponse {
    pub text: String,
    pub response: Value,
}

pub(super) fn parsed_openai_response(
    body: &[u8],
    content_type: Option<&str>,
) -> Result<ParsedOpenAiResponse, GatewayError> {
    if content_type.unwrap_or_default().contains("text/event-stream") || looks_like_sse(body) {
        return Ok(parse_openai_sse(body));
    }
    let raw: Value = serde_json::from_slice(body)?;
    Ok(ParsedOpenAiResponse {
        text: openai_output_text(&raw),
        response: raw,
    })
}

fn looks_like_sse(body: &[u8]) -> bool {
    String::from_utf8_lossy(body)
        .lines()
        .any(|line| line.trim_start().starts_with("data:"))
}

fn parse_openai_sse(body: &[u8]) -> ParsedOpenAiResponse {
    let mut text = String::new();
    let mut response = Value::Null;
    for line in String::from_utf8_lossy(body).lines() {
        apply_openai_sse_line(line, &mut text, &mut response);
    }
    if text.is_empty() && !response.is_null() {
        text = openai_output_text(&response);
    }
    ParsedOpenAiResponse { text, response }
}

fn apply_openai_sse_line(line: &str, text: &mut String, response: &mut Value) {
    let Some(data) = line.trim_start().strip_prefix("data:") else {
        return;
    };
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return;
    };
    apply_openai_sse_value(value, text, response);
}

fn apply_openai_sse_value(value: Value, text: &mut String, response: &mut Value) {
    match value.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta") => {
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                text.push_str(delta);
            }
        }
        Some("response.output_text.done") if text.is_empty() => {
            if let Some(done_text) = value.get("text").and_then(Value::as_str) {
                text.push_str(done_text);
            }
        }
        Some("response.completed") => {
            *response = value.get("response").cloned().unwrap_or(Value::Null);
        }
        _ => {}
    }
}

pub(super) fn openai_output_text(value: &Value) -> String {
    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        return text.to_owned();
    }
    let mut parts = Vec::new();
    if let Some(output) = value.get("output") {
        collect_output_text(output, &mut parts);
    }
    parts.join("")
}

fn collect_output_text(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_output_text(item, parts);
            }
        }
        Value::Object(map) => {
            collect_text_object(map, parts);
        }
        _ => {}
    }
}

fn collect_text_object(map: &serde_json::Map<String, Value>, parts: &mut Vec<String>) {
    let text_type = map.get("type").and_then(Value::as_str);
    if matches!(text_type, Some("output_text" | "text")) {
        if let Some(text) = map.get("text").and_then(Value::as_str) {
            parts.push(text.to_owned());
            return;
        }
    }
    for key in ["content", "output"] {
        if let Some(child) = map.get(key) {
            collect_output_text(child, parts);
        }
    }
}

pub(super) fn openai_usage(value: &Value) -> (i64, i64) {
    let usage = value.get("usage").unwrap_or(&Value::Null);
    let input = usage_token(usage, "input_tokens", "prompt_tokens");
    let output = usage_token(usage, "output_tokens", "completion_tokens");
    (input, output)
}

fn usage_token(usage: &Value, primary: &str, fallback: &str) -> i64 {
    usage
        .get(primary)
        .or_else(|| usage.get(fallback))
        .and_then(Value::as_i64)
        .unwrap_or_default()
}
