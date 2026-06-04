/**
 * Canonical builder for the public LAP session-page URL.
 *
 * Single source of truth so every place that links back to a session — the
 * Slack/Linear "View session" button (integrations/core/dispatcher) and the
 * `<lap_session_url>` injected into the agent's context (harness) — produces the
 * exact same, real URL. Agents must never construct session links themselves;
 * they hallucinate the id. They copy this instead.
 *
 * Prefers `LAP_BASE_URL` (the external https URL the UI is served from) and
 * falls back to `BASE_URL`. Returns `null` when neither is set, so callers omit
 * the link rather than emit a localhost URL into a production channel.
 */
export function buildSessionUrl(session_id: string): string | null {
  const base = process.env.LAP_BASE_URL || process.env.BASE_URL;
  if (!base) return null;
  const host = base.replace(/\/+$/, "");
  return `${host}/sessions/${encodeURIComponent(session_id)}`;
}
