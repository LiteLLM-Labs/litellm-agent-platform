import type { Prisma, Session, SessionAssessment } from "@prisma/client";

import { prisma } from "@/api/db";
import { env } from "@/api/env";
import { forwardSessionEvent } from "@/api/integrations/core/dispatcher";
import { rehydrateSession } from "@/api/rehydrate";
import type { HarnessMessage } from "@/api/types";

export type AssessmentState =
  | "on_track"
  | "slow_but_ok"
  | "off_track"
  | "blocked"
  | "failed";

export type AssessmentSeverity = "info" | "med" | "high";

export interface ApiSessionAssessment {
  id: string;
  session_id: string;
  state: AssessmentState | string;
  severity: AssessmentSeverity | string;
  blocker_type: string | null;
  diagnosis: string;
  recommended_action: string | null;
  confidence: number;
  evidence: unknown[];
  action_status: string;
  action_ref: string | null;
  // Spawned reviewer LAP agent session that critiques this target session.
  // The session IS the review — open it to read the agent's analysis.
  // Null until the worker first decides the target needs a deeper review.
  reviewer_session_id: string | null;
  checked_at: string;
  next_check_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AssessmentDraft {
  state: AssessmentState;
  severity: AssessmentSeverity;
  blocker_type: string | null;
  diagnosis: string;
  recommended_action: string | null;
  confidence: number;
  evidence: string[];
  next_check_at: Date;
  action_status: "none" | "watching" | "queued" | "executed" | "failed";
  action_ref: string | null;
  reviewer_session_id?: string | null;
}

type ReviewableSession = Prisma.SessionGetPayload<{
  include: { agent: true; assessments: true };
}>;

const REVIEW_INTERVAL_MS = 60_000;
const RECENT_TERMINAL_WINDOW_MS = 30 * 60_000;
const CREATING_BLOCKED_MS = 2 * 60_000;
const CREATING_SLOW_MS = 45_000;
const READY_NO_PROGRESS_MS = 10 * 60_000;
const READY_STALE_AFTER_ACTIVITY_MS = 5 * 60_000;

function ageMs(date: Date | null | undefined, now: number): number | null {
  return date ? now - date.getTime() : null;
}

function historyLength(history: Prisma.JsonValue | null): number {
  return Array.isArray(history) ? history.length : 0;
}

function hasResponse(response: Prisma.JsonValue | null): boolean {
  return Boolean(response && typeof response === "object");
}

function minutes(ms: number | null): number {
  if (ms === null) return 0;
  return Math.max(0, Math.round(ms / 60_000));
}

function nextCheck(now: number): Date {
  return new Date(now + REVIEW_INTERVAL_MS);
}

function issueSeverity(severity: AssessmentSeverity): string {
  if (severity === "high") return "critical";
  if (severity === "med") return "warning";
  return "info";
}

function actionWasAlreadyExecuted(
  latest: SessionAssessment | undefined,
  draft: AssessmentDraft,
): boolean {
  if (!latest) return false;
  if (latest.state !== draft.state) return false;
  if (latest.blocker_type !== draft.blocker_type) return false;
  return latest.action_status === "executed" && Boolean(latest.action_ref);
}

function reviewerActionBody(
  session: ReviewableSession,
  draft: AssessmentDraft,
): string {
  const evidence = draft.evidence.map((line) => `- ${line}`).join("\n");
  return [
    `Reviewer detected ${draft.state}${draft.blocker_type ? ` (${draft.blocker_type})` : ""}.`,
    "",
    `Session: ${session.session_id}`,
    `Agent: ${session.agent.agent_name ?? session.agent_id}`,
    "",
    `Diagnosis: ${draft.diagnosis}`,
    draft.recommended_action
      ? `Recommended action: ${draft.recommended_action}`
      : null,
    "",
    "Evidence:",
    evidence || "- No evidence captured.",
  ].filter(Boolean).join("\n");
}

async function fileReviewerIssue(
  session: ReviewableSession,
  draft: AssessmentDraft,
): Promise<string> {
  const title = `[Reviewer] ${draft.blocker_type ?? draft.state}`;
  const body = reviewerActionBody(session, draft);
  const existing = await prisma.agentIssue.findFirst({
    where: {
      agent_id: session.agent_id,
      status: "open",
      title: { equals: title, mode: "insensitive" },
    },
  });

  if (existing) {
    const [updated] = await prisma.$transaction([
      prisma.agentIssue.update({
        where: { issue_id: existing.issue_id },
        data: { times_seen: { increment: 1 } },
      }),
      prisma.agentIssueComment.create({
        data: {
          issue_id: existing.issue_id,
          session_id: session.session_id,
          body,
        },
      }),
    ]);
    return updated.issue_id;
  }

  const issue = await prisma.agentIssue.create({
    data: {
      agent_id: session.agent_id,
      session_id: session.session_id,
      title,
      body,
      severity: issueSeverity(draft.severity),
    },
  });
  return issue.issue_id;
}

async function notifyOriginatingIntegration(
  session: ReviewableSession,
  draft: AssessmentDraft,
): Promise<boolean> {
  const existing = await prisma.integrationSession.findUnique({
    where: { session_id: session.session_id },
    select: { session_id: true },
  });
  if (!existing) return false;

  await forwardSessionEvent(session.session_id, {
    type: draft.severity === "high" ? "error" : "thought",
    body: reviewerActionBody(session, draft),
  });
  return true;
}

async function resolveReviewerAgentId(): Promise<string | null> {
  const configured =
    process.env.LAP_REVIEWER_AGENT_ID ||
    process.env.REVIEWER_AGENT_ID ||
    "";
  if (configured.trim()) return configured.trim();

  const row = await prisma.agent.findFirst({
    where: {
      OR: [
        { agent_name: { equals: "LAP Reviewer", mode: "insensitive" } },
        { agent_name: { equals: "reviewer", mode: "insensitive" } },
        { agent_name: { contains: "reviewer", mode: "insensitive" } },
      ],
    },
    orderBy: { created_at: "asc" },
    select: { agent_id: true },
  });
  return row?.agent_id ?? null;
}

async function spawnReviewerSession(args: {
  title: string;
  prompt: string;
}): Promise<string | null> {
  const reviewerAgentId = await resolveReviewerAgentId();
  if (!reviewerAgentId) return null;

  const baseUrl =
    process.env.BASE_URL ||
    process.env.LAP_BASE_URL ||
    "http://localhost:3000";
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/api/v1/managed_agents/agents/${encodeURIComponent(reviewerAgentId)}/session`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.MASTER_KEY}`,
      },
      body: JSON.stringify({
        title: args.title,
        initial_prompt: args.prompt,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`reviewer session spawn failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { id?: string };
  return json.id ?? null;
}

async function startReviewerRepairSession(
  session: ReviewableSession,
  draft: AssessmentDraft,
  issueId: string,
): Promise<string | null> {
  const prompt = [
    "You are the platform reviewer agent. Autonomously investigate and fix this LAP session blocker.",
    "If the root cause is in the platform code, create a pull request with the fix.",
    "If the fix is a product or design change, post the proposal through the available Slack/tooling integration.",
    "Do not wait for a human to say go; proceed with bounded, reversible repairs and leave evidence.",
    "",
    reviewerActionBody(session, draft),
    "",
    `Linked reviewer issue: ${issueId}`,
  ].join("\n");

  return spawnReviewerSession({
    title: `Reviewer repair: ${draft.blocker_type ?? draft.state}`,
    prompt,
  });
}

// Stand up a reviewer session whose job is to critique — not repair — the
// target. Different prompt, no linked issue. Called from the worker when an
// assessment first lands in a concerning state and no prior critique session
// exists, so the agent's transcript becomes the human-readable review.
async function startReviewerCritiqueSession(
  session: ReviewableSession,
  draft: AssessmentDraft,
): Promise<string | null> {
  const prompt = [
    "You are the LAP platform reviewer. Your job is to critique this LAP session and propose concrete improvements to the platform itself.",
    "Read the linked session's transcript, pod logs, and sandbox state. Surface what the agent is doing well, what's blocking it, and which improvements would land the most reliability for LAP.",
    "Frame the output as a critique a senior agent operator would write — specific, evidence-backed, opinionated.",
    "Do not file code changes from this session; this is a read-only critique. Repair is handled by a separate reviewer flow.",
    "",
    reviewerActionBody(session, draft),
  ].join("\n");

  return spawnReviewerSession({
    title: `Reviewer critique: ${draft.blocker_type ?? draft.state} (${session.session_id.slice(0, 8)})`,
    prompt,
  });
}

function needsCritique(state: AssessmentState): boolean {
  return state === "off_track" || state === "blocked" || state === "failed";
}

// Spawn the critique session once per target-session and carry the id forward
// across worker ticks. The reviewer session IS the review — re-spawning every
// minute would create dozens of duplicate critique sessions.
async function ensureCritiqueSession(
  session: ReviewableSession,
  draft: AssessmentDraft,
  latest: SessionAssessment | undefined,
): Promise<string | null> {
  if (latest?.reviewer_session_id) return latest.reviewer_session_id;
  if (!needsCritique(draft.state)) return null;
  try {
    return await startReviewerCritiqueSession(session, draft);
  } catch (err) {
    console.warn("reviewer critique spawn failed:", err);
    return null;
  }
}

async function restartFailedSession(session: ReviewableSession): Promise<boolean> {
  if (session.status !== "failed" && session.status !== "dead") return false;
  const previousHistory = Array.isArray(session.history)
    ? (session.history as unknown as HarnessMessage[])
    : null;
  await rehydrateSession({
    agent: session.agent,
    session_id: session.session_id,
    oldTaskArn: session.task_arn,
    previousHistory,
  });
  return true;
}

async function executeAutonomousAction(
  session: ReviewableSession,
  draft: AssessmentDraft,
  latest: SessionAssessment | undefined,
): Promise<AssessmentDraft> {
  if (draft.action_status !== "queued") return draft;
  if (actionWasAlreadyExecuted(latest, draft)) {
    return {
      ...draft,
      action_status: "executed",
      action_ref: latest?.action_ref ?? draft.action_ref,
    };
  }

  const refs: string[] = [];
  try {
    const issueId = await fileReviewerIssue(session, draft);
    refs.push(`issue:${issueId}`);

    const notified = await notifyOriginatingIntegration(session, draft);
    if (notified) refs.push("integration:notified");

    if (draft.action_ref === "reviewer:auto-repair") {
      const restarted = await restartFailedSession(session);
      if (restarted) refs.push("session:restarted");
    }

    if (
      draft.action_ref === "reviewer:auto-repair" ||
      draft.action_ref === "reviewer:diagnose-and-repair" ||
      draft.action_ref === "reviewer:inspect-harness"
    ) {
      const repairSessionId = await startReviewerRepairSession(
        session,
        draft,
        issueId,
      );
      if (repairSessionId) refs.push(`repair_session:${repairSessionId}`);
    }

    return {
      ...draft,
      action_status: "executed",
      action_ref: refs.join(","),
    };
  } catch (err) {
    refs.push(`error:${err instanceof Error ? err.message : String(err)}`);
    return {
      ...draft,
      action_status: "failed",
      action_ref: refs.join(","),
    };
  }
}

export function toApiSessionAssessment(
  row: SessionAssessment,
): ApiSessionAssessment {
  return {
    id: row.assessment_id,
    session_id: row.session_id,
    state: row.state,
    severity: row.severity,
    blocker_type: row.blocker_type,
    diagnosis: row.diagnosis,
    recommended_action: row.recommended_action,
    confidence: row.confidence,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    action_status: row.action_status,
    action_ref: row.action_ref,
    reviewer_session_id: row.reviewer_session_id,
    checked_at: row.checked_at.toISOString(),
    next_check_at: row.next_check_at ? row.next_check_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function assessSessionRow(
  session: Session,
  now = Date.now(),
): AssessmentDraft {
  const sessionAge = ageMs(session.created_at, now);
  const idleAge = ageMs(session.last_seen_at ?? session.created_at, now);
  const stoppedAge = ageMs(session.stopped_at, now);
  const threadCount = historyLength(session.history);
  const evidence: string[] = [
    `session status is ${session.status}`,
    `session age is ${minutes(sessionAge)} minute(s)`,
  ];

  if (session.failure_reason) {
    evidence.push(`failure reason: ${session.failure_reason}`);
  }
  if (session.phase) {
    evidence.push(`current phase: ${session.phase}`);
  }
  if (threadCount > 0) {
    evidence.push(`stored history has ${threadCount} message(s)`);
  }

  if (session.status === "failed" || session.status === "dead") {
    const reason = session.failure_reason ?? session.status;
    return {
      state: "failed",
      severity: "high",
      blocker_type: reason.includes("timeout")
        ? "sandbox_timeout"
        : "sandbox_unavailable",
      diagnosis: `Session is ${session.status}; the agent cannot continue until the sandbox is recovered or restarted.`,
      recommended_action:
        "Review the diagnose bundle, restart the session if the task is still useful, and create a platform repair task if this repeats.",
      confidence: 92,
      evidence: stoppedAge === null
        ? evidence
        : [...evidence, `session stopped ${minutes(stoppedAge)} minute(s) ago`],
      next_check_at: nextCheck(now),
      action_status: "queued",
      action_ref: "reviewer:auto-repair",
    };
  }

  if (session.status === "creating") {
    if (sessionAge !== null && sessionAge >= CREATING_BLOCKED_MS) {
      return {
        state: "blocked",
        severity: "high",
        blocker_type: "sandbox_provisioning",
        diagnosis:
          "Session is still creating past the expected provisioning window.",
        recommended_action:
          "Open Diagnose, inspect pod/service readiness, and let the repair agent investigate if multiple sessions show the same blocker.",
        confidence: 86,
        evidence,
        next_check_at: nextCheck(now),
        action_status: "queued",
        action_ref: "reviewer:diagnose-and-repair",
      };
    }
    if (sessionAge !== null && sessionAge >= CREATING_SLOW_MS) {
      return {
        state: "slow_but_ok",
        severity: "med",
        blocker_type: "sandbox_provisioning_slow",
        diagnosis:
          "Session is still creating but has not crossed the blocked threshold yet.",
        recommended_action:
          "Keep watching. Escalate if it remains creating on the next check.",
        confidence: 68,
        evidence,
        next_check_at: nextCheck(now),
        action_status: "watching",
        action_ref: "reviewer:next-check",
      };
    }
    return {
      state: "on_track",
      severity: "info",
      blocker_type: null,
      diagnosis: "Session is provisioning within the expected window.",
      recommended_action: null,
      confidence: 70,
      evidence,
      next_check_at: nextCheck(now),
      action_status: "none",
      action_ref: null,
    };
  }

  if (session.status === "ready") {
    if (
      threadCount === 0
      && !hasResponse(session.response)
      && sessionAge !== null
      && sessionAge >= READY_NO_PROGRESS_MS
    ) {
      return {
        state: "off_track",
        severity: "med",
        blocker_type: "no_agent_progress",
        diagnosis:
          "Sandbox is ready, but there is no recorded agent response or message history after a long idle window.",
        recommended_action:
          "Check whether the task was actually sent. If it was, ask the reviewer to inspect harness events and tool availability.",
        confidence: 72,
        evidence,
        next_check_at: nextCheck(now),
        action_status: "queued",
        action_ref: "reviewer:inspect-harness",
      };
    }

    if (
      threadCount > 0
      && idleAge !== null
      && idleAge >= READY_STALE_AFTER_ACTIVITY_MS
    ) {
      return {
        state: "slow_but_ok",
        severity: "info",
        blocker_type: "quiet_after_activity",
        diagnosis:
          "The run has prior activity and is currently quiet. No intervention is needed yet.",
        recommended_action: null,
        confidence: 62,
        evidence: [...evidence, `last activity was ${minutes(idleAge)} minute(s) ago`],
        next_check_at: nextCheck(now),
        action_status: "watching",
        action_ref: "reviewer:next-check",
      };
    }

    return {
      state: "on_track",
      severity: "info",
      blocker_type: null,
      diagnosis: "Session is ready and has no reviewer-visible blocker.",
      recommended_action: null,
      confidence: 76,
      evidence,
      next_check_at: nextCheck(now),
      action_status: "none",
      action_ref: null,
    };
  }

  return {
    state: "off_track",
    severity: "med",
    blocker_type: "unknown_session_state",
    diagnosis: `Session has unexpected status "${session.status}".`,
    recommended_action:
      "Inspect the session row and reconcile worker logs before retrying.",
    confidence: 65,
    evidence,
    next_check_at: nextCheck(now),
    action_status: "queued",
    action_ref: "reviewer:inspect-session-state",
  };
}

export async function assessAndStoreSession(
  session_id: string,
): Promise<SessionAssessment> {
  const session = await prisma.session.findUnique({
    where: { session_id },
    include: {
      agent: true,
      assessments: { orderBy: { checked_at: "desc" }, take: 1 },
    },
  });
  if (!session) {
    throw new Error(`session ${session_id} not found`);
  }
  const initialDraft = assessSessionRow(session);
  const latest = session.assessments[0];
  const draft = await executeAutonomousAction(session, initialDraft, latest);
  const reviewerSessionId = await ensureCritiqueSession(session, draft, latest);
  return prisma.sessionAssessment.create({
    data: {
      session_id,
      state: draft.state,
      severity: draft.severity,
      blocker_type: draft.blocker_type,
      diagnosis: draft.diagnosis,
      recommended_action: draft.recommended_action,
      confidence: draft.confidence,
      evidence: draft.evidence,
      action_status: draft.action_status,
      action_ref: draft.action_ref,
      reviewer_session_id: reviewerSessionId,
      next_check_at: draft.next_check_at,
    },
  });
}

export async function getLatestAssessment(
  session_id: string,
): Promise<SessionAssessment | null> {
  return prisma.sessionAssessment.findFirst({
    where: { session_id },
    orderBy: { checked_at: "desc" },
  });
}

export async function pollSessionsForReview(): Promise<{
  inspected: number;
  assessed: number;
}> {
  const now = Date.now();
  const terminalCutoff = new Date(now - RECENT_TERMINAL_WINDOW_MS);
  const rows = await prisma.session.findMany({
    where: {
      OR: [
        { status: { in: ["creating", "ready"] } },
        {
          status: { in: ["failed", "dead"] },
          stopped_at: { gte: terminalCutoff },
        },
        {
          status: { in: ["failed", "dead"] },
          stopped_at: null,
          created_at: { gte: terminalCutoff },
        },
      ],
    },
    include: {
      agent: true,
      assessments: {
        orderBy: { checked_at: "desc" },
        take: 1,
      },
    },
    take: 100,
  });

  let assessed = 0;
  for (const row of rows) {
    const latest = row.assessments[0];
    if (
      latest?.next_check_at
      && latest.next_check_at.getTime() > now
    ) {
      continue;
    }
    const initialDraft = assessSessionRow(row, now);
    const draft = await executeAutonomousAction(row, initialDraft, latest);
    await prisma.sessionAssessment.create({
      data: {
        session_id: row.session_id,
        state: draft.state,
        severity: draft.severity,
        blocker_type: draft.blocker_type,
        diagnosis: draft.diagnosis,
        recommended_action: draft.recommended_action,
        confidence: draft.confidence,
        evidence: draft.evidence,
        action_status: draft.action_status,
        action_ref: draft.action_ref,
        next_check_at: draft.next_check_at,
      },
    });
    assessed += 1;
  }

  return { inspected: rows.length, assessed };
}
