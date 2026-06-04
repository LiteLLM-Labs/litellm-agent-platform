/**
 * Well-known upstream hosts agents commonly talk to, plus a heuristic that maps
 * a secret env-var name to the host it belongs to.
 *
 * One source of truth shared by:
 *   - the agent UI — preset chips for the allowed-hosts editor, and auto-fill
 *     for each credential's "used for host" selector.
 *   - the backend — validating that every credential is bound to a host inside
 *     the agent's egress allowlist, and auto-binding a known key when the caller
 *     didn't specify one.
 *
 * Keeping this list in `src/shared` is deliberate: the UI and backend must
 * never disagree on what "Linear" or "GitHub" means.
 */

export interface WellKnownHost {
  /** Stable id used by preset chips. */
  id: string;
  /** Human label shown in the UI. */
  label: string;
  /** Egress entries this preset adds (exact hosts or `*.` wildcards). */
  hosts: string[];
}

export const WELL_KNOWN_HOSTS: readonly WellKnownHost[] = [
  { id: "github", label: "GitHub", hosts: ["github.com", "api.github.com", "*.githubusercontent.com"] },
  { id: "linear", label: "Linear", hosts: ["api.linear.app"] },
  { id: "openai", label: "OpenAI", hosts: ["api.openai.com"] },
  { id: "anthropic", label: "Anthropic", hosts: ["api.anthropic.com"] },
  { id: "slack", label: "Slack", hosts: ["slack.com", "www.slack.com"] },
  { id: "npm", label: "npm", hosts: ["registry.npmjs.org"] },
  { id: "pypi", label: "PyPI", hosts: ["pypi.org", "files.pythonhosted.org"] },
];

/** Map a secret env-var name to the well-known preset it most likely targets. */
const KEY_HEURISTICS: ReadonlyArray<{ test: RegExp; id: string }> = [
  { test: /^LINEAR_/i, id: "linear" },
  { test: /^(GH_|GITHUB_)/i, id: "github" },
  { test: /^OPENAI_/i, id: "openai" },
  { test: /^ANTHROPIC_/i, id: "anthropic" },
  { test: /^SLACK_/i, id: "slack" },
];

export function wellKnownHostById(id: string): WellKnownHost | undefined {
  return WELL_KNOWN_HOSTS.find((h) => h.id === id);
}

/**
 * Hosts a secret with this key name should be allowed to reach, derived from
 * the key prefix (e.g. `LINEAR_API_KEY` → `["api.linear.app"]`). Empty when the
 * key matches no known service — the caller must then bind a host explicitly.
 */
export function suggestHostsForKey(key: string): string[] {
  const match = KEY_HEURISTICS.find((h) => h.test.test(key));
  return match ? (wellKnownHostById(match.id)?.hosts ?? []) : [];
}

// A host entry is a bare domain, a `*.` wildcard suffix, an IPv4 literal, or a
// CIDR block. This mirrors the rule grammar the vault parses (vault/src/server.ts
// parseRule) so the UI/backend can reject malformed entries before they reach
// the proxy. Intentionally loose on the domain shape — exact DNS validation is
// the upstream's problem, not ours.
const HOST_ENTRY_RE = /^(\*\.)?[A-Za-z0-9._-]+(\/\d{1,2})?$/;

export function isValidEgressHost(entry: string): boolean {
  const s = entry.trim();
  return s.length > 0 && s.length <= 253 && HOST_ENTRY_RE.test(s);
}

/**
 * Whether `host` is permitted by a single allowlist `rule`. Mirrors the vault's
 * `matchesRule` for the two forms a credential binding can use — an exact host
 * and a `*.` wildcard suffix — so the platform's reconcile/validation agrees
 * with what the proxy will actually enforce. CIDR/IP rules fall back to exact
 * compare here (bindings are domains in practice; the vault still does the full
 * CIDR check at egress).
 */
export function hostMatchesRule(host: string, rule: string): boolean {
  const r = rule.trim();
  if (r.startsWith("*.")) {
    const suffix = r.slice(1); // "*.example.com" -> ".example.com"
    return host === suffix.slice(1) || host.endsWith(suffix);
  }
  return host === r;
}

/** Whether `host` is permitted by any rule in `allow`. */
export function hostAllowedByList(host: string, allow: Iterable<string>): boolean {
  for (const rule of allow) if (hostMatchesRule(host, rule)) return true;
  return false;
}
