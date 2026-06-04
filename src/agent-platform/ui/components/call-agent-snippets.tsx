"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Loader2, Play } from "lucide-react";

import { cn } from "@/ui/lib/utils";
import {
  ApiError,
  getPublicProxyBase,
  harnessResponseText,
  sendMessage,
  spawnSession,
} from "@/ui/lib/api";

type Lang = "curl" | "python" | "typescript";

const LANG_LABEL: Record<Lang, string> = {
  curl: "cURL",
  python: "Python",
  typescript: "TypeScript",
};

interface CallAgentSnippetsProps {
  agentId: string;
}

interface Step {
  title: string;
  hint: string;
  code: string;
}

function curlSteps(base: string, agentId: string): Step[] {
  return [
    {
      title: "1 — Spawn a session",
      hint: "Provisions a fresh Fargate task; ~50–90s the first time. Returns a session id you'll use for every subsequent call.",
      code: `curl -X POST ${base}/v1/managed_agents/agents/${agentId}/session \\
  -H "Authorization: Bearer $LITELLM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title": "smoke test", "initial_prompt": "In one sentence, what is this repo?"}'`,
    },
    {
      title: "2 — Send a message, get the response",
      hint: "Blocking call. The proxy forwards to the harness and waits for the assistant's full reply, then returns it.",
      code: `curl -X POST ${base}/v1/managed_agents/sessions/$SESSION_ID/message \\
  -H "Authorization: Bearer $LITELLM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "In one sentence, what is this repo?"}'`,
    },
    {
      title: "3 — Stream events as the agent works",
      hint: "Server-Sent Events. Subscribe in parallel with /message to see tool calls + partial output land in real time.",
      code: `curl -N ${base}/v1/managed_agents/sessions/$SESSION_ID/events \\
  -H "Authorization: Bearer $LITELLM_API_KEY"`,
    },
  ];
}

function pythonSteps(base: string, agentId: string): Step[] {
  return [
    {
      title: "1 — Spawn a session",
      hint: "Provisions a fresh Fargate task; ~50–90s the first time. Returns a session id you'll use for every subsequent call.",
      code: `import os, httpx

BASE = "${base}"
KEY = os.environ["LITELLM_API_KEY"]
AGENT_ID = "${agentId}"

with httpx.Client(timeout=420, headers={"Authorization": f"Bearer {KEY}"}) as c:
    session = c.post(
        f"{BASE}/v1/managed_agents/agents/{AGENT_ID}/session",
        json={"title": "smoke test", "initial_prompt": "In one sentence, what is this repo?"},
    ).json()

session_id = session["id"]`,
    },
    {
      title: "2 — Send a message, get the response",
      hint: "Blocking call. Each POST returns the assistant's full reply once it's done.",
      code: `with httpx.Client(timeout=300, headers={"Authorization": f"Bearer {KEY}"}) as c:
    reply = c.post(
        f"{BASE}/v1/managed_agents/sessions/{session_id}/message",
        json={"text": "In one sentence, what is this repo?"},
    ).json()

print(reply)`,
    },
    {
      title: "3 — Stream events as the agent works",
      hint: "Open the SSE stream in a separate task / thread before you POST the message — partial chunks, tool calls, and final text all arrive here.",
      code: `import httpx

with httpx.stream(
    "GET",
    f"{BASE}/v1/managed_agents/sessions/{session_id}/events",
    headers={"Authorization": f"Bearer {KEY}"},
    timeout=None,
) as r:
    for line in r.iter_lines():
        if line:
            print(line)`,
    },
  ];
}

function typescriptSteps(base: string, agentId: string): Step[] {
  return [
    {
      title: "1 — Spawn a session",
      hint: "Provisions a fresh Fargate task; ~50–90s the first time. Returns a session id you'll use for every subsequent call.",
      code: `const BASE = "${base}";
const KEY = process.env.LITELLM_API_KEY!;
const AGENT_ID = "${agentId}";

const session = await fetch(
  \`\${BASE}/v1/managed_agents/agents/\${AGENT_ID}/session\`,
  {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "smoke test", initial_prompt: "In one sentence, what is this repo?" }),
  },
).then((r) => r.json());

const sessionId = session.id;`,
    },
    {
      title: "2 — Send a message, get the response",
      hint: "Blocking call. Each POST returns the assistant's full reply once it's done.",
      code: `const reply = await fetch(
  \`\${BASE}/v1/managed_agents/sessions/\${sessionId}/message\`,
  {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "In one sentence, what is this repo?" }),
  },
).then((r) => r.json());

console.log(reply);`,
    },
    {
      title: "3 — Stream events as the agent works",
      hint: "Subscribe in parallel with the message POST. The SSE stream emits partial deltas, tool calls, and the final text frame.",
      code: `const stream = await fetch(
  \`\${BASE}/v1/managed_agents/sessions/\${sessionId}/events\`,
  { headers: { Authorization: \`Bearer \${KEY}\` } },
);

const reader = stream.body!.getReader();
const dec = new TextDecoder();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  process.stdout.write(dec.decode(value));
}`,
    },
  ];
}

interface SnippetBlockProps {
  step: Step;
}

function SnippetBlock({ step }: SnippetBlockProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(step.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-zinc-950 text-zinc-100">
      <div className="flex items-start justify-between gap-4 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-zinc-100">
            {step.title}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
            {step.hint}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy snippet"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-300"
        >
          {copied ? (
            <>
              <Check className="size-3" aria-hidden /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3" aria-hidden /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-[12px] leading-relaxed">
        <code className="font-mono">{step.code}</code>
      </pre>
    </div>
  );
}

const TRY_PROMPT = "In one sentence, what is this repo?";

type RunPhase = "idle" | "spawning" | "asking" | "done" | "failed";

interface RunResult {
  phase: RunPhase;
  startedAt: number;
  elapsedSec: number;
  error?: string;
  prompt?: string;
  response?: string;
  sessionId?: string;
}

export function CallAgentSnippets({ agentId }: CallAgentSnippetsProps) {
  const [lang, setLang] = useState<Lang>("curl");
  const [base, setBase] = useState<string>("");
  const [run, setRun] = useState<RunResult>({
    phase: "idle",
    startedAt: 0,
    elapsedSec: 0,
  });

  useEffect(() => {
    let cancelled = false;
    void getPublicProxyBase().then((b) => {
      if (!cancelled) setBase(b || window.location.origin);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Tick a 1s elapsed counter while the run is in flight so the user has
  // something to look at during the 50–90s Fargate cold start.
  useEffect(() => {
    if (run.phase !== "spawning" && run.phase !== "asking") return;
    const id = window.setInterval(() => {
      setRun((prev) => {
        if (prev.phase !== "spawning" && prev.phase !== "asking") return prev;
        return {
          ...prev,
          elapsedSec: Math.floor((Date.now() - prev.startedAt) / 1000),
        };
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [run.phase]);

  async function handleTry() {
    if (run.phase === "spawning" || run.phase === "asking") return;
    const startedAt = Date.now();
    setRun({
      phase: "spawning",
      startedAt,
      elapsedSec: 0,
      prompt: TRY_PROMPT,
    });

    try {
      const session = await spawnSession(agentId, {
        title: "ui try-it",
        initial_prompt: TRY_PROMPT,
      });
      // The spawn response carries the assistant's first reply when an
      // initial_prompt is set, so we don't need a separate /message call.
      const text =
        harnessResponseText(session.response) ||
        "(spawn returned no text — try sending a message manually)";
      setRun({
        phase: "done",
        startedAt,
        elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
        prompt: TRY_PROMPT,
        response: text,
        sessionId: session.id,
      });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setRun({
        phase: "failed",
        startedAt,
        elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
        prompt: TRY_PROMPT,
        error: msg,
      });
    }
  }

  // Step 2 reuses the session_id from step 1 so the user can keep chatting.
  const followUpDisabled = !run.sessionId || run.phase === "asking";
  async function handleFollowUp() {
    if (!run.sessionId || run.phase === "asking") return;
    const startedAt = Date.now();
    setRun((prev) => ({ ...prev, phase: "asking", startedAt, elapsedSec: 0 }));
    try {
      const reply = await sendMessage(run.sessionId, {
        text: "What about its router?",
      });
      const text =
        harnessResponseText(reply) || "(no text in response)";
      setRun((prev) => ({
        ...prev,
        phase: "done",
        elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
        prompt: "What about its router?",
        response: text,
      }));
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setRun((prev) => ({
        ...prev,
        phase: "failed",
        elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
        error: msg,
      }));
    }
  }

  const steps = useMemo(() => {
    switch (lang) {
      case "curl":
        return curlSteps(base, agentId);
      case "python":
        return pythonSteps(base, agentId);
      case "typescript":
        return typescriptSteps(base, agentId);
    }
  }, [lang, base, agentId]);

  const running = run.phase === "spawning" || run.phase === "asking";
  const tryLabel =
    run.phase === "spawning"
      ? `Spawning… ${run.elapsedSec}s`
      : run.phase === "asking"
        ? `Asking… ${run.elapsedSec}s`
        : run.phase === "done" || run.phase === "failed"
          ? "Run again"
          : "Try it";

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Call this agent
        </h2>
        <div className="flex items-center gap-1">
          <div role="tablist" aria-label="Language" className="flex gap-1">
            {(Object.keys(LANG_LABEL) as Lang[]).map((l) => {
              const active = l === lang;
              return (
                <button
                  key={l}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={() => setLang(l)}
                  className={cn(
                    "rounded-md px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    active
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {LANG_LABEL[l]}
                </button>
              );
            })}
          </div>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => void handleTry()}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-[11px] font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {running ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <Play className="size-3" aria-hidden />
            )}
            {tryLabel}
          </button>
        </div>
      </div>


      {(run.phase === "spawning" ||
        run.phase === "asking" ||
        run.phase === "done" ||
        run.phase === "failed") &&
      run.prompt ? (
        <div className="mb-3 overflow-hidden rounded-md border bg-card/40">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium uppercase tracking-wider">
              Live result
            </span>
            <span aria-hidden>·</span>
            <span className="font-mono">{run.phase}</span>
            {run.elapsedSec > 0 ? (
              <span className="ml-auto tabular-nums">
                {run.elapsedSec}s
              </span>
            ) : null}
          </div>
          <div className="px-3 py-2 text-[13px]">
            <div className="text-muted-foreground">
              <span className="font-medium text-foreground">You:</span>{" "}
              {run.prompt}
            </div>
            {run.phase === "spawning" ? (
              <div className="mt-2 flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                Provisioning sandbox… first call may take a moment.
              </div>
            ) : null}
            {run.phase === "asking" ? (
              <div className="mt-2 flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                Asking the agent…
              </div>
            ) : null}
            {run.phase === "done" && run.response ? (
              <div className="mt-2 whitespace-pre-wrap">
                <span className="font-medium">Agent:</span> {run.response}
              </div>
            ) : null}
            {run.phase === "failed" && run.error ? (
              <div className="mt-2 font-mono text-[11px] text-destructive">
                {run.error}
              </div>
            ) : null}

            {run.phase === "done" && run.sessionId ? (
              <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-mono">session</span>
                <span className="truncate font-mono text-foreground">
                  {run.sessionId.slice(0, 8)}
                </span>
                <button
                  type="button"
                  onClick={() => void handleFollowUp()}
                  disabled={followUpDisabled}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Send follow-up
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        {steps.map((s) => (
          <SnippetBlock key={s.title} step={s} />
        ))}
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        The whole flow is: <span className="font-mono">spawn</span> →{" "}
        <span className="font-mono">message</span> (or stream{" "}
        <span className="font-mono">events</span>) → repeat. The{" "}
        <span className="font-medium">Try it</span> button runs steps 1 + 2
        against this proxy using the server-side{" "}
        <span className="font-mono">LITELLM_API_KEY</span> — the key never
        ships to the browser.
      </p>
    </section>
  );
}
