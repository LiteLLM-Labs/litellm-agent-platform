// Table-driven unit tests for the frame translator (runtime.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateFrame } from "../../../../src/lite-harness-sdk/managed-agents/runtime.mjs";

// Helper: assert result is an empty array.
function assertEmpty(result, label) {
  assert.equal(Array.isArray(result), true, `${label}: expected array`);
  assert.equal(result.length, 0, `${label}: expected empty array, got length ${result.length}`);
}

// ---------------------------------------------------------------------------
// Frames that must produce []
// ---------------------------------------------------------------------------

test("system init -> []", () => {
  const result = translateFrame({ type: "system", subtype: "init" });
  assertEmpty(result, "system/init");
});

test("control_response -> []", () => {
  const result = translateFrame({ type: "control_response", response: {} });
  assertEmpty(result, "control_response");
});

test("stream_event -> []", () => {
  const result = translateFrame({ type: "stream_event" });
  assertEmpty(result, "stream_event");
});

test("unknown type -> []", () => {
  const result = translateFrame({ type: "whatever" });
  assertEmpty(result, "unknown");
});

test("null input -> []", () => {
  const result = translateFrame(null);
  assertEmpty(result, "null");
});

// ---------------------------------------------------------------------------
// assistant text block -> agent.message
// ---------------------------------------------------------------------------

test("assistant text block -> one agent.message event", () => {
  const frame = {
    type: "assistant",
    message: { content: [{ type: "text", text: "hi" }] },
  };
  const result = translateFrame(frame);
  assert.equal(result.length, 1, "expected exactly one event");
  const ev = result[0];
  assert.equal(ev.type, "agent.message", "event type");
  assert.ok(Array.isArray(ev.content), "content is array");
  assert.equal(ev.content.length, 1, "one content block");
  assert.equal(ev.content[0].type, "text", "block type");
  assert.equal(ev.content[0].text, "hi", "block text");
});

// ---------------------------------------------------------------------------
// assistant tool_use block -> agent.tool_use
// ---------------------------------------------------------------------------

test("assistant tool_use block -> one agent.tool_use event", () => {
  const frame = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls" } },
      ],
    },
  };
  const result = translateFrame(frame);
  assert.equal(result.length, 1, "expected exactly one event");
  const ev = result[0];
  assert.equal(ev.type, "agent.tool_use", "event type");
  assert.equal(ev.name, "bash", "tool name");
  assert.equal(ev.tool_use_id, "toolu_1", "tool_use_id");
  assert.deepEqual(ev.input, { cmd: "ls" }, "tool input");
});

// ---------------------------------------------------------------------------
// user tool_result block -> agent.tool_result
// ---------------------------------------------------------------------------

test("user tool_result block -> one agent.tool_result event", () => {
  const frame = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "out",
          is_error: false,
        },
      ],
    },
  };
  const result = translateFrame(frame);
  assert.equal(result.length, 1, "expected exactly one event");
  const ev = result[0];
  assert.equal(ev.type, "agent.tool_result", "event type");
  assert.equal(ev.tool_use_id, "toolu_1", "tool_use_id");
  assert.equal(ev.content, "out", "content");
  assert.equal(ev.is_error, false, "is_error");
});

// ---------------------------------------------------------------------------
// result success -> session.status_idle
// ---------------------------------------------------------------------------

test("result success -> session.status_idle", () => {
  const frame = {
    type: "result",
    subtype: "success",
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0,
  };
  const result = translateFrame(frame);
  assert.equal(result.length, 1, "expected exactly one event");
  const ev = result[0];
  assert.equal(ev.type, "session.status_idle", "event type");
  assert.ok(typeof ev.usage === "object" && ev.usage !== null, "usage present");
  assert.equal(ev.total_cost_usd, 0, "total_cost_usd");
});

// ---------------------------------------------------------------------------
// result error -> session.status_error
// ---------------------------------------------------------------------------

test("result error -> session.status_error with message", () => {
  const frame = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "boom",
  };
  const result = translateFrame(frame);
  assert.equal(result.length, 1, "expected exactly one event");
  const ev = result[0];
  assert.equal(ev.type, "session.status_error", "event type");
  assert.ok(
    typeof ev.error === "string" && ev.error.includes("boom"),
    `error field should include "boom", got: ${ev.error}`,
  );
});
