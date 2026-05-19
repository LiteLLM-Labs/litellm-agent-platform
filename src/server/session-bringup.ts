/**
 * Session bring-up orchestrator.
 *
 * Extracted from the POST /agents/{id}/session route so non-HTTP callers
 * (currently the cron tick in `src/server/cron.ts`) can use exactly the
 * same warm-claim → fall-back-to-cold dance the API route does. The HTTP
 * route is a thin wrapper that adds auth + body parsing + the immediate
 * 200 response, then delegates the actual bring-up to `runBringUp` here.
 *
 * Nothing in this file reads request-scoped state: bring-up only touches
 * prisma, k8s, and the harness, so it's safe to invoke fire-and-forget
 * from anywhere in the platform (HTTP route, worker tick, integrations).
 */

import { prisma } from "@/server/db";
import {
  runTask,
  waitHttpReady,
  waitRunningGetUrl,
} from "@/server/k8s";
import { putCachedSession } from "@/server/sessionCache";
import {
  expandMessage,
  harnessCreateSession,
  harnessSendMessage,
} from "@/server/harness";
import {
  type AgentRow,
  type HarnessMessageResponse,
  type SessionRow,
  type WarmTaskRow,
} from "@/server/types";
import {
  deleteClaimedWarmTask,
  markClaimedTaskDead,
} from "@/server/warmPool";
import { safeStopTask } from "@/server/reconcile";
import type { Prisma } from "@prisma/client";

export interface BringUpResult {
  updated: SessionRow;
  response: HarnessMessageResponse | null;
}

export interface InitialAttachment {
  name?: string;
  mime_type: string;
  base64: string;
}

export interface BringUpBody {
  initial_prompt?: string;
  title?: string;
  env_vars?: Record<string, string>;
  initial_attachments?: InitialAttachment[];
}

// ---------------------------------------------------------------------------
// Phase marker. Writes the current bring-up phase onto the Session row so the
// UI can render a real progress indicator instead of the wall-clock-driven
// approximation. Best-effort: a phase write must never break the bring-up
// itself, so all errors are swallowed (and logged at warn level so a systemic
// DB failure is still visible in the operator logs).
// ---------------------------------------------------------------------------

async function setPhase(
  session_id: string,
  phase: string,
  detail?: string,
): Promise<void> {
  try {
    await prisma.session.update({
      where: { session_id },
      data: { phase, phase_detail: detail ?? null },
    });
  } catch (e) {
    console.warn(
      `setPhase(${session_id}, ${phase}) failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Background bring-up orchestrator.
//
// Wraps the warm/cold + fallback dance. Called fire-and-forget so the HTTP
// response can return the `creating` Session row in ~50ms instead of
// waiting 30s-8min for the sandbox to spin up. The UI polls /sessions/{id}
// for the status flip.
//
// Failures (warm + cold both dead, harness unreachable, network) flip the
// Session row to `failed` with the reason so the client can render it.
// We log too — a silent fire-and-forget is impossible to debug.
// ---------------------------------------------------------------------------

export async function runBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
  warm: WarmTaskRow | null,
): Promise<void> {
  try {
    let result: BringUpResult;
    if (warm) {
      try {
        result = await warmBringUp(agent, session_id, body, warm);
      } catch (warmErr) {
        // Warm task was claimed but its harness is unreachable. Don't
        // bubble the failure to the user — kill the warm row and fall
        // through to a cold spawn.
        const reason =
          warmErr instanceof Error ? warmErr.message : String(warmErr);
        console.warn(
          `warm bring-up failed for warm_task_id=${warm.warm_task_id}: ${reason}; falling back to cold spawn`,
        );
        await markClaimedTaskDead(
          warm.warm_task_id,
          `warm bring-up failed: ${reason}`,
        );
        await prisma.session.update({
          where: { session_id },
          data: { task_arn: null, sandbox_url: null },
        });
        result = await coldBringUp(agent, session_id, body);
      }
    } else {
      result = await coldBringUp(agent, session_id, body);
    }

    if (warm) await deleteClaimedWarmTask(warm.warm_task_id).catch(() => {});

    void result;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(
      `session create failed: session_id=${session_id} agent_id=${agent.agent_id} reason=${reason}`,
    );
    const row = await prisma.session
      .findUnique({ where: { session_id }, select: { task_arn: true } })
      .catch(() => null);
    if (row?.task_arn)
      void safeStopTask(row.task_arn, "session bring-up failed").catch(() => {});
    await prisma.session
      .update({
        where: { session_id },
        data: { status: "failed", failure_reason: reason },
      })
      .catch((dbErr) => {
        console.error(
          `failed to mark session ${session_id} as failed: ${
            dbErr instanceof Error ? dbErr.message : String(dbErr)
          }`,
        );
      });
  }
}

// ---------------------------------------------------------------------------
// Cold path — RunTask + waits + harness session.
// ---------------------------------------------------------------------------

async function coldBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
): Promise<BringUpResult> {
  await setPhase(session_id, "creating_sandbox");
  const { task_arn } = await runTask({
    agent,
    session_id,
    env_vars: body.env_vars,
  });
  await prisma.session.update({
    where: { session_id },
    data: { task_arn },
  });
  await setPhase(session_id, "pod_pending");
  const sandbox_url = await waitRunningGetUrl(task_arn, agent);
  await setPhase(session_id, "pod_running");
  const rawSandboxFiles = (agent as Record<string, unknown>).sandbox_files;
  const sandboxFiles = Array.isArray(rawSandboxFiles)
    ? (rawSandboxFiles as import("@/server/types").SandboxFileSpec[])
    : [];
  await setPhase(session_id, "waiting_harness");
  await waitHttpReady(sandbox_url);
  await setPhase(session_id, "harness_ready");
  return finishBringUp(agent, session_id, body, sandbox_url, sandboxFiles);
}

// ---------------------------------------------------------------------------
// Warm path — task already running, just run the harness handshake.
// ---------------------------------------------------------------------------

async function warmBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
  warm: WarmTaskRow,
): Promise<BringUpResult> {
  if (!warm.task_arn || !warm.sandbox_url) {
    throw new Error(
      `claimed warm task ${warm.warm_task_id} missing task_arn or sandbox_url`,
    );
  }
  await prisma.session.update({
    where: { session_id },
    data: { task_arn: warm.task_arn },
  });
  const rawWarmFiles = (agent as Record<string, unknown>).sandbox_files;
  const warmFiles = Array.isArray(rawWarmFiles)
    ? (rawWarmFiles as import("@/server/types").SandboxFileSpec[])
    : [];
  await setPhase(session_id, "harness_ready");
  return finishBringUp(agent, session_id, body, warm.sandbox_url, warmFiles);
}

// ---------------------------------------------------------------------------
// Shared finish — same harness handshake for both paths.
// ---------------------------------------------------------------------------

async function finishBringUp(
  agent: AgentRow,
  session_id: string,
  body: BringUpBody,
  sandbox_url: string,
  files: import("@/server/types").SandboxFileSpec[] = [],
): Promise<BringUpResult> {
  await setPhase(session_id, "cloning_repo");
  const harness_session_id = await harnessCreateSession({
    sandbox_url,
    title: body.title,
    prompt: agent.prompt ?? undefined,
    files: files.length > 0 ? files : undefined,
  });
  const updated = await prisma.session.update({
    where: { session_id },
    data: {
      status: "ready",
      phase: "ready",
      phase_detail: null,
      sandbox_url,
      harness_session_id,
      last_seen_at: new Date(),
    },
  });
  putCachedSession({
    session_id,
    agent_id: agent.agent_id,
    agent_model: agent.model,
    sandbox_url,
    harness_session_id,
    status: "ready",
  });
  if (
    body.initial_prompt ||
    (body.initial_attachments && body.initial_attachments.length > 0)
  ) {
    void runInitialPrompt(
      agent,
      session_id,
      sandbox_url,
      harness_session_id,
      body.initial_prompt ?? "",
      body.initial_attachments,
    );
  }
  return { updated, response: null };
}

// ---------------------------------------------------------------------------
// Fire-and-forget runner for the initial agent task. Persists the reply on
// success, logs + persists a failure_reason on error. Never throws — any
// rejection here would be unhandled (the caller doesn't await this).
// ---------------------------------------------------------------------------

async function runInitialPrompt(
  agent: AgentRow,
  session_id: string,
  sandbox_url: string,
  harness_session_id: string,
  initial_prompt: string,
  initial_attachments?: InitialAttachment[],
): Promise<void> {
  try {
    const parts =
      initial_attachments && initial_attachments.length > 0
        ? [
            ...(initial_prompt ? [{ type: "text", text: initial_prompt }] : []),
            ...initial_attachments.map((a) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: a.mime_type,
                data: a.base64,
              },
            })),
          ]
        : expandMessage(initial_prompt);
    const response = await harnessSendMessage({
      sandbox_url,
      harness_session_id,
      model: agent.model,
      parts,
    });
    await prisma.session.update({
      where: { session_id },
      data: {
        response: response as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `initial_prompt send failed: session_id=${session_id} reason=${reason}`,
    );
    await prisma.session
      .update({
        where: { session_id },
        data: { failure_reason: `initial_prompt failed: ${reason}` },
      })
      .catch((dbErr) => {
        console.error(
          `failed to record initial_prompt failure for ${session_id}: ${
            dbErr instanceof Error ? dbErr.message : String(dbErr)
          }`,
        );
      });
  }
}
