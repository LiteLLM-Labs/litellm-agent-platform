import { fetch } from "undici";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { runTask, waitHttpReady, waitRunningGetUrl } from "@/server/k8s";
import { HARNESS_EXECUTOR, type AgentRow } from "@/server/types";

const EXECUTE_TIMEOUT_MS = 300_000;

const sandboxMap = new Map<string, string>();

function mapKey(session_id: string, name: string): string {
  return `${session_id}:${name}`;
}

export async function provisionSandbox(
  session_id: string,
  name: string,
  agent: AgentRow,
  existingSandboxes?: Record<string, string>,
): Promise<string> {
  if (env.LOCAL_EXECUTOR_URL) {
    sandboxMap.set(mapKey(session_id, name), env.LOCAL_EXECUTOR_URL);
    const merged = { ...(existingSandboxes ?? {}), [name]: env.LOCAL_EXECUTOR_URL };
    await prisma.session.update({
      where: { session_id },
      // Cast required: Prisma client types pre-date the `sandboxes` column
      // migration. Remove the cast after `prisma generate` is re-run.
      data: { sandboxes: merged } as Prisma.SessionUpdateInput,
    });
    return `sandbox '${name}' ready`;
  }

  if (env.LOCAL_SANDBOX_URL) {
    sandboxMap.set(mapKey(session_id, name), env.LOCAL_SANDBOX_URL);
    const merged = { ...(existingSandboxes ?? {}), [name]: env.LOCAL_SANDBOX_URL };
    await prisma.session.update({
      where: { session_id },
      // Cast required: Prisma client types pre-date the `sandboxes` column
      // migration. Remove the cast after `prisma generate` is re-run.
      data: { sandboxes: merged } as Prisma.SessionUpdateInput,
    });
    return `sandbox '${name}' ready`;
  }

  const { task_arn } = await runTask({ agent: { ...agent, harness_id: HARNESS_EXECUTOR }, session_id });

  // Only write task_arn for non-brain-inline sessions. brain-inline sessions
  // use a shared harness pod — writing the sandbox pod's task_arn causes the
  // reconciler ghost sweep to kill the brain-inline session when the sandbox
  // pod dies from idle timeout.
  if (agent.harness_id !== "claude-code-brain-inline") {
    await prisma.session.update({
      where: { session_id },
      data: { task_arn },
    });
  }

  const sandbox_url = await waitRunningGetUrl(task_arn, agent);
  await waitHttpReady(sandbox_url);

  const merged = { ...(existingSandboxes ?? {}), [name]: sandbox_url };
  await prisma.session.update({
    where: { session_id },
    // Cast required: Prisma client types pre-date the `sandboxes` column
    // migration. Remove the cast after `prisma generate` is re-run.
    data: { sandboxes: merged } as Prisma.SessionUpdateInput,
  });

  sandboxMap.set(mapKey(session_id, name), sandbox_url);
  return `sandbox '${name}' ready`;
}

export async function executeSandbox(
  session_id: string,
  name: string,
  cmd: string,
): Promise<string> {
  let sandbox_url = sandboxMap.get(mapKey(session_id, name));
  if (!sandbox_url) {
    // Cold path: pod restarted and wiped in-memory map. Rehydrate from DB.
    const row = await (prisma.session.findUnique as (args: unknown) => Promise<Record<string, unknown> | null>)({
      where: { session_id },
      select: { sandboxes: true },
    });
    const stored = (row?.sandboxes as Record<string, string> | null)?.[name];
    if (stored) {
      sandboxMap.set(mapKey(session_id, name), stored);
      sandbox_url = stored;
    }
  }
  if (!sandbox_url) {
    return `error: sandbox '${name}' not provisioned — call provision first`;
  }

  const url = `${sandbox_url.replace(/\/+$/, "")}/execute`;
  const secret = env.EXECUTOR_SECRET;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-executor-secret"] = secret;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ cmd }),
      signal: AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
    });
    const data = (await res.json()) as { output?: string };
    return data.output ?? "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function getSandboxUrl(
  session_id: string,
  name: string,
): string | undefined {
  return sandboxMap.get(mapKey(session_id, name));
}

export async function clearSandboxes(session_id: string): Promise<void> {
  for (const key of sandboxMap.keys()) {
    if (key.startsWith(`${session_id}:`)) {
      sandboxMap.delete(key);
    }
  }
  await prisma.session.update({
    where: { session_id },
    data: { sandboxes: {} } as Prisma.SessionUpdateInput,
  }).catch(() => {});
}
