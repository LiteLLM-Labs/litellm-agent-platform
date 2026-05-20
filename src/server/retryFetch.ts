/**
 * Small retry wrapper for `undici.fetch` calls into the harness.
 *
 * Why: a single transient hop failure (load-balancer rebooting, harness
 * pod still warming up, packet loss) currently bubbles straight to the
 * user as `502 harness request failed`. Three quick retries with full
 * jitter eats most of those without changing call sites.
 *
 * What we retry on:
 *
 *   - "connect" failures: ECONNREFUSED / ECONNRESET / ETIMEDOUT / DNS /
 *     undici connect timeout. These mean the request never reached the
 *     harness, so retry is always safe — even for non-idempotent POSTs.
 *
 *   - 5xx responses (502/503/504 by default): also typically transient
 *     infra-level failures (LB has no upstream yet, gateway timeout,
 *     bad gateway). Opt-in via `retryOn5xx` because retrying a 5xx for
 *     a non-idempotent POST can double-process. Callers know whether
 *     their endpoint is safe to repeat.
 *
 *   - 429 Too Many Requests when `retryOn5xx` is set: honor `Retry-After`
 *     if the server sends it, otherwise fall back to the jittered delay.
 *
 * What we never retry on:
 *
 *   - Other 4xx (400, 401, 403, 404, 409, 422): caller error, retrying
 *     won't fix it.
 *
 *   - AbortError: user cancelled or the outer request was aborted —
 *     retrying would defeat the cancellation.
 *
 * Backoff: full jitter (random between 0 and `min(cap, base * 2^attempt)`).
 * Defaults — 3 attempts, base 300ms, cap 3000ms — are tuned for human-
 * latency UI flows: best case no extra delay, worst case ~3s before
 * surfacing failure. Tune via options when calling from a background job.
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_MS = 300;
const DEFAULT_CAP_MS = 3000;
const DEFAULT_RETRY_STATUSES = [502, 503, 504] as const;

const RETRYABLE_CONNECT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

export interface RetryFetchOptions {
  /** Max attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Base delay in ms before exponential growth. Default 300. */
  baseMs?: number;
  /** Cap on a single backoff window in ms. Default 3000. */
  capMs?: number;
  /**
   * Retry on 5xx (and 429). Default false — connect-level retries only.
   * Set to true for idempotent calls (GETs, list endpoints, session
   * create where the harness dedupes by id).
   */
  retryOn5xx?: boolean;
  /**
   * Which 5xx statuses to retry when `retryOn5xx` is true. Default
   * [502, 503, 504]. 500 is excluded by default because it usually means
   * the upstream actually processed the request and errored — retrying
   * just spams the same failure.
   */
  retryStatuses?: readonly number[];
  /**
   * Tag used in the retry log line ("retryFetch[<label>] attempt 2/3 ..."),
   * so flaky endpoints jump out of the logs.
   */
  label?: string;
  /** Hook used by tests to make backoff deterministic. */
  sleep?: (ms: number) => Promise<void>;
  /** Hook used by tests to seed jitter. */
  random?: () => number;
}

export interface RetryableFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
}

/**
 * `fetch`-shaped retry wrapper. Takes a thunk (so each attempt builds a
 * fresh Request — required because `fetch` consumes its body once) and
 * returns the first successful Response, or re-throws the final error.
 *
 * The thunk's return type is generic so this works with both browser
 * `fetch` (returns `Response`) and `undici.fetch` (returns its own
 * `Response`) without needing to import either type.
 */
export async function retryFetch<R extends RetryableFetchResponse>(
  thunk: () => Promise<R>,
  options: RetryFetchOptions = {},
): Promise<R> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseMs = DEFAULT_BASE_MS,
    capMs = DEFAULT_CAP_MS,
    retryOn5xx = false,
    retryStatuses = DEFAULT_RETRY_STATUSES,
    label,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await thunk();
      if (
        retryOn5xx &&
        (retryStatuses.includes(res.status) || res.status === 429) &&
        attempt < maxAttempts
      ) {
        const delay = computeDelay({
          attempt,
          baseMs,
          capMs,
          random,
          retryAfter: res.headers.get("retry-after"),
        });
        logRetry({ label, attempt, maxAttempts, reason: `HTTP ${res.status}`, delay });
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (isAbortError(err)) throw err;
      if (!isConnectError(err)) throw err;
      if (attempt >= maxAttempts) throw err;
      const delay = computeDelay({ attempt, baseMs, capMs, random });
      logRetry({
        label,
        attempt,
        maxAttempts,
        reason: connectErrorReason(err),
        delay,
      });
      await sleep(delay);
    }
  }

  // Loop only falls through when the final attempt returned a retryable
  // status — return that response so the caller can inspect / error on it
  // with its own normal "not ok" path. If lastError is set we already
  // rethrew above, so this branch only fires after a status-based retry.
  throw lastError ?? new Error("retryFetch: exhausted retries without a response");
}

interface ComputeDelayOpts {
  attempt: number;
  baseMs: number;
  capMs: number;
  random: () => number;
  retryAfter?: string | null;
}

function computeDelay({
  attempt,
  baseMs,
  capMs,
  random,
  retryAfter,
}: ComputeDelayOpts): number {
  // Honor Retry-After if the server sent a numeric seconds value. Ignore
  // the HTTP-date form — overkill for what's effectively a hint, and a
  // misconfigured server could pin us at very long delays.
  if (retryAfter) {
    const secs = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(capMs, secs * 1000);
    }
  }
  const window = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * window);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
}

/**
 * True for "the request never made it" — TCP refused, DNS broke,
 * undici connect timed out, socket reset before any bytes arrived.
 * These are always safe to retry, regardless of HTTP verb.
 */
export function isConnectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_CONNECT_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const c = (cause as { code?: unknown }).code;
    if (typeof c === "string" && RETRYABLE_CONNECT_CODES.has(c)) return true;
  }
  // undici's TimeoutError doesn't always set `.code` consistently across
  // versions — fall back to name sniffing for the AbortSignal.timeout()
  // case used in harness.ts.
  const name = (err as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "ConnectTimeoutError") return true;
  return false;
}

function connectErrorReason(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown";
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const c = (cause as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  const name = (err as { name?: unknown }).name;
  if (typeof name === "string") return name;
  return "unknown";
}

function logRetry(opts: {
  label?: string;
  attempt: number;
  maxAttempts: number;
  reason: string;
  delay: number;
}): void {
  const tag = opts.label ? `retryFetch[${opts.label}]` : "retryFetch";
  console.warn(
    `${tag} attempt ${opts.attempt}/${opts.maxAttempts} retrying after ${opts.delay}ms (reason: ${opts.reason})`,
  );
}
