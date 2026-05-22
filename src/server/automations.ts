/**
 * Cron-driven automations: scheduled triggers that spawn a session for an
 * agent on a recurring cadence.
 *
 * Two halves live here:
 *   - Cron helpers (validate / compute next fire) used by the API routes when
 *     a user creates or edits an automation. Schedules are 5-field cron
 *     evaluated in UTC.
 *   - `tickAutomations`, called every worker tick (see src/worker/index.ts),
 *     which claims due rows and fires their sessions.
 *
 * Multi-pod safety: claiming uses `SELECT ... FOR UPDATE SKIP LOCKED` inside a
 * transaction that also advances `next_run_at` to the next occurrence before
 * commit. Two pods ticking at the same instant can't double-fire — pod B's
 * SKIP LOCKED skips the row pod A holds, and once pod A commits the row's
 * next_run_at is in the future so it isn't re-claimed. Session bring-up (a
 * 30s+ cold spawn) runs *outside* the transaction so the row lock window stays
 * tiny.
 */

import { Cron } from "croner";
import { prisma } from "@/server/db";
import { env } from "@/server/env";

// Cron expressions are interpreted in UTC so the schedule a user picks means
// the same wall-clock instant regardless of where the worker pod runs.
const CRON_TIMEZONE = "UTC";

// Cap rows claimed per tick so one busy instant can't spawn an unbounded
// number of sandboxes in a single transaction.
const MAX_DUE_PER_TICK = 50;

/** True if `expr` is a cron pattern croner can schedule. */
export function isValidCron(expr: string): boolean {
  try {
    // Constructing throws on an unparseable pattern. No function is passed,
    // so this never schedules a real timer — it's just a parse.
    new Cron(expr, { timezone: CRON_TIMEZONE });
    return true;
  } catch {
    return false;
  }
}

/**
 * Next fire instant strictly after `from` (default now) for `expr`, in UTC.
 * Throws on an invalid pattern — callers validate with `isValidCron` first.
 * Returns null when the pattern has no future occurrence (shouldn't happen
 * for a recurring 5-field cron, but croner allows one-shot patterns).
 */
export function computeNextRunAt(expr: string, from: Date = new Date()): Date | null {
  return new Cron(expr, { timezone: CRON_TIMEZONE }).nextRun(from);
}

// Shape of the rows returned by the raw claim query — snake_case DB columns.
interface DueAutomationRow {
  automation_id: string;
  agent_id: string;
  name: string | null;
  instruction: string;
  cron_expr: string;
}

export interface AutomationTickResult {
  claimed: number;
  fired: number;
  failed: number;
}

/**
 * Spawn a session for one automation via the existing v1 session-create route.
 * Mirrors the integrations dispatcher: an in-process fetch authenticated with
 * MASTER_KEY, so all warm-pool / cold-fallback logic is reused rather than
 * duplicated here.
 */
async function spawnAutomationSession(auto: DueAutomationRow): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const url = `${baseUrl}/api/v1/managed_agents/agents/${encodeURIComponent(
    auto.agent_id,
  )}/session`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MASTER_KEY}`,
    },
    body: JSON.stringify({
      initial_prompt: auto.instruction,
      title: `[auto] ${auto.name ?? auto.automation_id.slice(0, 8)}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`session create failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * One worker pass: claim every due automation, advance each to its next
 * occurrence, then fire the sessions. Safe to run concurrently across pods.
 */
export async function tickAutomations(): Promise<AutomationTickResult> {
  // Bind a JS Date rather than SQL now(): next_run_at is a `timestamp`
  // (no tz) that Prisma reads/writes as UTC, so comparing it to a bound Date
  // is unambiguous, whereas `now()` is a timestamptz that Postgres would cast
  // against the session timezone. Reuse the same instant for the due check and
  // the re-anchoring below.
  const now = new Date();

  // Claim + advance atomically. The lock is held only for the duration of the
  // next_run_at updates — never across the session spawn below.
  const due = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<DueAutomationRow[]>`
      SELECT automation_id, agent_id, name, instruction, cron_expr
      FROM managed_agent_automation
      WHERE enabled = true
        AND next_run_at IS NOT NULL
        AND next_run_at <= ${now}
      ORDER BY next_run_at ASC
      LIMIT ${MAX_DUE_PER_TICK}
      FOR UPDATE SKIP LOCKED
    `;

    for (const auto of rows) {
      // Re-anchor from `now`, not the missed scheduled time, so a worker that
      // was down doesn't fire a burst of catch-up runs on recovery.
      const nextRunAt = computeNextRunAt(auto.cron_expr, now);
      await tx.automation.update({
        where: { automation_id: auto.automation_id },
        data: {
          last_run_at: now,
          next_run_at: nextRunAt,
          // A cron with no further occurrence (e.g. a date that has now
          // passed) yields a null next_run_at. Disable the row so it doesn't
          // sit "Enabled" forever with no next fire — the worker query filters
          // out null next_run_at, so it'd otherwise be silently stuck.
          ...(nextRunAt === null ? { enabled: false } : {}),
        },
      });
    }
    return rows;
  });

  if (due.length === 0) return { claimed: 0, fired: 0, failed: 0 };

  // Fire outside the transaction. Failures are isolated per automation —
  // next_run_at was already advanced, so a failed spawn just waits for the
  // next occurrence rather than retrying on the next tick.
  const results = await Promise.allSettled(due.map((a) => spawnAutomationSession(a)));
  let fired = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      fired++;
    } else {
      failed++;
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(
        `automation spawn failed: automation_id=${due[i].automation_id} agent_id=${due[i].agent_id} reason=${reason}`,
      );
    }
  }
  return { claimed: due.length, fired, failed };
}
