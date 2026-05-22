/**
 * Server-side helpers for the Automations feature.
 *
 * The only external dependency is `croner`, a TypeScript-native cron library
 * that parses standard 5-field expressions and computes the next occurrence.
 * No side effects at import time — all exports are pure functions.
 */

import { Cron } from "croner";

/**
 * Compute the next UTC fire time for a cron expression.
 *
 * Throws if the expression is invalid or produces no future occurrence
 * (e.g. `"0 0 31 2 *"` — Feb never has 31 days). The caller is responsible
 * for surfacing the error message.
 */
export function nextRunAt(cronExpr: string): Date {
  let job: Cron;
  try {
    // paused: true means the job is never scheduled — we only use it for
    // nextRun() computation. timezone: "UTC" keeps all fire times in UTC so
    // the DB column (TIMESTAMPTZ) stores a consistent absolute instant
    // regardless of the server's local timezone.
    job = new Cron(cronExpr, { paused: true, timezone: "UTC" });
  } catch (e) {
    throw new Error(
      `Invalid cron expression "${cronExpr}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const next = job.nextRun();
  if (!next) {
    throw new Error(
      `Cron expression "${cronExpr}" produces no future occurrence.`,
    );
  }
  return next;
}

/**
 * Validate a cron expression without computing the next run.
 * Returns the error message string if invalid, or null if valid.
 */
export function validateCronExpr(expr: string): string | null {
  try {
    nextRunAt(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Human-readable label for a cron expression.
 * Returns the expression itself when no preset matches.
 */
export function cronLabel(expr: string): string {
  const presets: Record<string, string> = {
    "0 * * * *":     "Every hour",
    "0 */2 * * *":   "Every 2 hours",
    "0 */6 * * *":   "Every 6 hours",
    "0 */12 * * *":  "Every 12 hours",
    "0 0 * * *":     "Daily at midnight (UTC)",
    "0 9 * * *":     "Daily at 9 am (UTC)",
    "0 9 * * 1-5":   "Weekdays at 9 am (UTC)",
    "0 9 * * 1":     "Weekly on Monday at 9 am (UTC)",
    "0 0 * * 0":     "Weekly on Sunday at midnight (UTC)",
    "0 0 1 * *":     "Monthly on the 1st at midnight (UTC)",
  };
  return presets[expr] ?? expr;
}
