/**
 * Cross-backend sandbox dispatcher. Routes runTask / stopTask /
 * waitRunningGetUrl / waitHttpReady / listTaggedTasks to either the AWS
 * Fargate or Kubernetes implementation based on `env.SANDBOX_BACKEND`.
 *
 * Callers (route handlers, reconciler, warm pool) should import from this
 * module — never reach into fargate.ts or k8s.ts directly. That keeps the
 * backend choice in one place and makes it cheap to add a third runtime.
 *
 * The shared contract lives in src/server/types.ts (RunTaskOpts, TaggedTask).
 */

import { env } from "@/server/env";
import * as fargate from "@/server/fargate";
import * as k8s from "@/server/k8s";
import type { AgentRow, RunTaskOpts, TaggedTask } from "@/server/types";

function isK8s(): boolean {
  return env.SANDBOX_BACKEND === "k8s";
}

export async function runTask(
  opts: RunTaskOpts,
): Promise<{ task_arn: string }> {
  return isK8s() ? k8s.runTask(opts) : fargate.runTask(opts);
}

export async function stopTask(
  task_arn: string,
  reason: string = "session-ended",
): Promise<void> {
  return isK8s()
    ? k8s.stopTask(task_arn, reason)
    : fargate.stopTask(task_arn, reason);
}

/**
 * Wait until the sandbox is reachable and return the URL the harness HTTP
 * client should hit. Replaces the old `waitRunningGetIp` + URL template
 * pattern at call sites — the URL shape differs between backends (Fargate
 * uses the task's public IP + agent.container_port; k8s uses
 * K8S_NODE_HOST:nodePort), so the construction can't live in the caller.
 */
export async function waitRunningGetUrl(
  task_arn: string,
  agent: AgentRow,
  timeout_ms?: number,
): Promise<string> {
  return isK8s()
    ? k8s.waitRunningGetUrl(task_arn, agent, timeout_ms)
    : fargate.waitRunningGetUrl(task_arn, agent, timeout_ms);
}

export async function waitHttpReady(
  sandbox_url: string,
  timeout_ms?: number,
): Promise<void> {
  return isK8s()
    ? k8s.waitHttpReady(sandbox_url, timeout_ms)
    : fargate.waitHttpReady(sandbox_url, timeout_ms);
}

export async function listTaggedTasks(): Promise<TaggedTask[]> {
  return isK8s() ? k8s.listTaggedTasks() : fargate.listTaggedTasks();
}
