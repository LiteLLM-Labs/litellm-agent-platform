/**
 * Client-side mirror of the env_vars validation rules in
 * `src/api/types.ts`. Kept in a separate file so the agent detail page
 * can import these limits without pulling in any `@/server/*` modules
 * (which depend on Prisma / Node-only crypto and break the client bundle).
 *
 * If you change a value here, update the corresponding constant in
 * `src/api/types.ts` so client + server agree.
 */

export const ENV_VARS_MAX_KEYS = 50;
export const ENV_VARS_MAX_BYTES = 16_384;

/**
 * Keys the harness runtime reserves. The backend rejects PATCH bodies that
 * try to set any of these. Mirrors `RESERVED_ENV_KEYS` in
 * `src/api/types.ts`.
 */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  "REPO_URL",
  "BRANCH",
  "LITELLM_API_KEY",
  "LITELLM_API_BASE",
  "LITELLM_DEFAULT_MODEL",
  "AGENT_PROMPT",
  "PORT",
  "GIT_TOKEN",
  "AGENT_REQUIREMENTS",
]);

/**
 * env var name format the backend accepts: starts with letter or underscore,
 * followed by letters/digits/underscores. We only enforce the looser
 * "non-empty + no whitespace" rule in the UI per the feature spec — anything
 * the backend rejects with a clearer message comes back as an inline 400.
 */
export const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Key substrings that imply the value is sensitive — those rows get the
 * value masked by default and a small hint to the user. Other rows still
 * have reveal toggles.
 */
const SENSITIVE_KEY_PATTERNS = ["KEY", "TOKEN", "SECRET", "PASSWORD"];

export function isSensitiveKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => upper.includes(p));
}

export interface EnvVarValidationError {
  /** 1-based row index in the editor, or null for whole-form errors. */
  row: number | null;
  message: string;
}

/**
 * Validate an env vars map client-side. Returns the list of errors found —
 * empty array means "safe to PATCH". The backend re-validates with the same
 * rules; this is purely UX so the user sees mistakes before submit.
 */
export function validateEnvVars(
  rows: ReadonlyArray<{ key: string; value: string }>,
): EnvVarValidationError[] {
  const errors: EnvVarValidationError[] = [];
  const seen = new Set<string>();

  rows.forEach((r, i) => {
    const row = i + 1;
    const key = r.key;
    if (key === "") {
      errors.push({ row, message: "Key is required" });
      return;
    }
    if (/\s/.test(key)) {
      errors.push({ row, message: "Key cannot contain whitespace" });
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      errors.push({ row, message: `"${key}" is reserved by the harness` });
    }
    if (seen.has(key)) {
      errors.push({ row, message: `Duplicate key "${key}"` });
    }
    seen.add(key);
  });

  if (rows.length > ENV_VARS_MAX_KEYS) {
    errors.push({
      row: null,
      message: `Too many variables (max ${ENV_VARS_MAX_KEYS})`,
    });
  }

  // Match the backend's byte check on the JSON-encoded final map.
  const finalMap: Record<string, string> = {};
  for (const r of rows) {
    if (r.key && !RESERVED_ENV_KEYS.has(r.key)) finalMap[r.key] = r.value;
  }
  const encoded = JSON.stringify(finalMap);
  if (encoded.length > ENV_VARS_MAX_BYTES) {
    errors.push({
      row: null,
      message: `Total size ${encoded.length} bytes exceeds limit of ${ENV_VARS_MAX_BYTES}`,
    });
  }

  return errors;
}
