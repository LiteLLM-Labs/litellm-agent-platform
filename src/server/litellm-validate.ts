/**
 * Validate that a model string actually routes to a working upstream
 * provider through the LiteLLM gateway.
 *
 * Background: LiteLLM's `/v1/models` advertises any model name configured
 * in the proxy's `model_list`, but proxy admins frequently add dated
 * variants (e.g. `anthropic/claude-opus-4-7-20260416`) whose upstream
 * provider doesn't recognize them. Such a model is listed but returns 404
 * on the first real chat. Today the platform stores those model strings
 * without checking, so agents save fine and then EVERY session created
 * from them fails the moment a user types — a confusing failure mode
 * because the agent looks healthy in the UI.
 *
 * This helper sends a minimal 1-token completion to LiteLLM up front so
 * the platform rejects broken model strings at agent create/update time
 * with a clear error message that includes the upstream provider's own
 * error, plus a hint to use the bare-alias form when that's what failed.
 */

import { env } from "@/server/env";
import { httpError } from "@/server/types";

/**
 * Ping LiteLLM's chat-completions endpoint with the given model and a
 * 1-token "hi" body. Throws an HttpError(400, …) on any 4xx response so
 * the caller's request bubbles up the upstream error to the user.
 *
 * 5xx and network errors are treated as transient — they should not
 * block agent save. Operators don't want their workflow gated on a
 * flaky upstream.
 */
export async function validateAgentModel(model: string): Promise<void> {
  const base = env.LITELLM_API_BASE.replace(/\/+$/, "");
  const url = `${base}/v1/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.LITELLM_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // Network/timeout — don't block save. Log and pass through.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[validateAgentModel] upstream unreachable; allowing save anyway: ${msg}`);
    return;
  }

  if (response.ok) return;

  // 5xx is treated as transient and non-blocking. 4xx is the user's
  // problem and should surface.
  if (response.status >= 500) {
    console.warn(`[validateAgentModel] upstream ${response.status}; allowing save anyway`);
    return;
  }

  // Pull the upstream error message out. LiteLLM nests provider errors
  // inside `error.message`. Fall back to raw text if the shape is unknown.
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (body?.error && typeof body.error.message === "string") {
      detail = body.error.message;
    } else {
      detail = JSON.stringify(body);
    }
  } catch {
    detail = await response.text().catch(() => "(no response body)");
  }

  // Trim noisy fallback chains LiteLLM appends — they confuse the user.
  // `[\s\S]*` instead of `.*/s` keeps this valid under older TS targets.
  detail = detail.replace(/No fallback model group[\s\S]*/, "").trim();

  // Hint: dated suffixes (e.g. `-20260416`) frequently 404 upstream when
  // the bare alias works. Suggest the bare alias when we detect one.
  const datedSuffix = model.match(/-(\d{8})$/);
  const hint = datedSuffix
    ? ` Try the bare alias '${model.slice(0, -datedSuffix[0].length)}' — dated variants often aren't recognized upstream even when LiteLLM lists them.`
    : "";

  httpError(400, {
    error: `model '${model}' is not usable through the LiteLLM gateway (HTTP ${response.status}).${hint}`,
    upstream_error: detail.slice(0, 800),
  });
}
