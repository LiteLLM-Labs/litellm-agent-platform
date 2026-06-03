#!/usr/bin/env node
// Standalone fake subprocess for managed-session tests. Reads NDJSON from stdin;
// on a {type:"user"} frame it streams back an assistant + result frame.
//
// Behaviour is selected via env (forwarded by createState({ env })):
//   FAKE_CRASH=1      exit(1) right after the initialize handshake (tests error status)
//   FAKE_MODE=strict  mimic the real stream-json server: one turn at a time. A
//                     second user frame that arrives mid-turn is answered with an
//                     error result "A turn is already in progress". Each accepted
//                     turn completes after FAKE_DELAY_MS (default 200) ms.
//   (default)         answer every user frame immediately.

import { createInterface } from "node:readline";

let agent = "fake";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--agent" && args[i + 1] !== undefined) {
    agent = args[i + 1];
    i++;
  }
}

const CRASH = process.env.FAKE_CRASH === "1";
const STRICT = process.env.FAKE_MODE === "strict";
const DELAY = Number(process.env.FAKE_DELAY_MS) || 200;

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function assistant() {
  return {
    type: "assistant",
    message: { model: "fake", content: [{ type: "text", text: `hello from ${agent}` }] },
    parent_tool_use_id: null,
  };
}
function result({ isError = false, text } = {}) {
  return {
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    session_id: "sess_fake",
    is_error: isError,
    num_turns: 1,
    result: text ?? `hello from ${agent}`,
    usage: { input_tokens: 1, output_tokens: 3 },
    total_cost_usd: 0,
  };
}

let turnActive = false;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Crash after the initialize handshake to exercise the error path.
  if (CRASH && frame?.type === "control_request" && frame.request?.subtype === "initialize") {
    process.exit(1);
  }

  if (frame?.type !== "user") return; // control_request & others ignored

  if (!STRICT) {
    write(assistant());
    write(result());
    return;
  }

  // strict: serialize turns like the real stream-json server.
  if (turnActive) {
    write(result({ isError: true, text: "A turn is already in progress" }));
    return;
  }
  turnActive = true;
  setTimeout(() => {
    write(assistant());
    write(result());
    turnActive = false;
  }, DELAY);
});

rl.on("close", () => process.exit(0));
