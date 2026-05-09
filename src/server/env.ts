/**
 * Parses process.env into the locked ServerEnv contract from types.ts.
 *
 * Validation is lazy — triggered on first property access, not on import.
 * `next build` evaluates route modules to collect page data without the
 * runtime .env in scope, so eager parsing made the build fail with
 * "Invalid server environment configuration". Lazy parsing keeps the same
 * fail-fast guarantee at runtime (first request) while letting builds
 * succeed in CI / Docker without secrets baked in.
 */

import { z } from "zod";
import type { ServerEnv } from "@/server/types";

const CONTAINER_ENV_PREFIX = "CONTAINER_ENV_";

// AWS_* fields are required only when SANDBOX_BACKEND=fargate. The k8s
// backend ignores them entirely; making them optional here lets a k8s-only
// setup boot without ECS plumbing in scope. We reapply the "required when
// fargate" check via superRefine below.
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  UI_USERNAME: z.string().min(1),
  MASTER_KEY: z.string().min(8),
  SANDBOX_BACKEND: z.enum(["fargate", "k8s"]).default("fargate"),
  AWS_REGION: z.string().optional().default(""),
  AWS_CLUSTER: z.string().optional().default(""),
  // Credentials are resolved by the SDK's default provider chain at runtime,
  // not parsed here. Set whatever the chain understands: env vars,
  // AWS_PROFILE + ~/.aws/credentials, SSO, instance role.
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_PROFILE: z.string().optional(),
  AWS_TASK_DEFINITION_ARN: z.string().optional().default(""),
  AWS_SUBNETS: z
    .string()
    .optional()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),
  AWS_SECURITY_GROUP: z.string().optional().default(""),
  K8S_NAMESPACE: z.string().min(1).default("default"),
  K8S_NODE_HOST: z.string().optional().default("host.docker.internal"),
  K8S_NODEPORT_MIN: z.coerce.number().int().min(30000).max(32767).default(30000),
  K8S_NODEPORT_MAX: z.coerce.number().int().min(30000).max(32767).default(30099),
  K8S_IMAGE_PULL_POLICY: z.enum(["Never", "IfNotPresent", "Always"]).default("Never"),
  K8S_HARNESS_IMAGE: z.string().min(1).default("opencode-sandbox:dev"),
  K8S_API_SERVER: z.string().optional().default(""),
  PREINSTALLED_GITHUB_REPO: z.string().min(1),
  LITELLM_API_BASE: z.string().min(1),
  LITELLM_API_KEY: z.string().min(1),
  CONTAINER_PORT: z.coerce.number().int().positive().default(4096),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),

  // Warm pool — pre-provisioned Fargate tasks waiting to be claimed by a
  // session create. Default of 2 keeps two tasks ready for the most
  // recently active agent so users get sub-5s session creates out of the
  // box (cost ≈ $32/mo at 512 CPU / 1024 mem). Set to 0 to disable.
  WARM_POOL_SIZE: z.coerce.number().int().nonnegative().default(2),
  WARM_POOL_MAX_PROVISIONING: z.coerce.number().int().positive().default(2),
  WARM_POOL_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  // Ignore agents whose last session is older than this — don't keep
  // warm tasks around for an agent that hasn't been used in a long time.
  WARM_POOL_RECENT_AGENT_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(24),
});

function collectContainerEnvPassthrough(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(CONTAINER_ENV_PREFIX)) continue;
    if (typeof value !== "string") continue;
    const stripped = key.slice(CONTAINER_ENV_PREFIX.length);
    if (stripped.length === 0) continue;
    out[stripped] = value;
  }
  return out;
}

const FARGATE_REQUIRED_FIELDS = [
  "AWS_REGION",
  "AWS_CLUSTER",
  "AWS_TASK_DEFINITION_ARN",
  "AWS_SECURITY_GROUP",
] as const;

function parseEnv(): ServerEnv {
  // During `next build` most hosting platforms (Render, Fly, Railway, etc.)
  // don't expose runtime env vars to the build container, so collecting page
  // data for API routes that import this module would always crash. Skip
  // validation in the build phase — runtime imports re-evaluate this file
  // with the real env in place.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return {} as ServerEnv;
  }
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid server environment configuration:\n${issues}\n` +
        `See .env.example for the required keys.`,
    );
  }
  const data = parsed.data;
  // Backend-conditional required fields. Fargate path needs AWS_* + subnets;
  // K8s path needs none of those.
  if (data.SANDBOX_BACKEND === "fargate") {
    const missing: string[] = [];
    for (const f of FARGATE_REQUIRED_FIELDS) {
      if (!data[f] || (typeof data[f] === "string" && data[f].length === 0)) {
        missing.push(f);
      }
    }
    if (data.AWS_SUBNETS.length === 0) missing.push("AWS_SUBNETS");
    if (missing.length > 0) {
      throw new Error(
        `SANDBOX_BACKEND=fargate requires: ${missing.join(", ")}. ` +
          `Set SANDBOX_BACKEND=k8s to use the Kubernetes backend instead.`,
      );
    }
  }
  if (data.K8S_NODEPORT_MIN > data.K8S_NODEPORT_MAX) {
    throw new Error(
      `K8S_NODEPORT_MIN (${data.K8S_NODEPORT_MIN}) > K8S_NODEPORT_MAX (${data.K8S_NODEPORT_MAX})`,
    );
  }
  return {
    ...data,
    containerEnvPassthrough: collectContainerEnvPassthrough(process.env),
  };
}

let _env: ServerEnv | null = null;

function getEnv(): ServerEnv {
  if (_env === null) _env = parseEnv();
  return _env;
}

// Proxy makes every `env.FOO` access trigger parseEnv on first read. After
// that, subsequent accesses hit the cached object directly. Property writes
// are blocked — env should be treated as immutable runtime config.
export const env: ServerEnv = new Proxy({} as ServerEnv, {
  get(_target, prop) {
    return getEnv()[prop as keyof ServerEnv];
  },
  has(_target, prop) {
    return prop in getEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(getEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getEnv(), prop);
  },
});
