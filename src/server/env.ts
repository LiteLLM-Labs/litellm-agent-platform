/**
 * Parses process.env into the locked ServerEnv contract from types.ts.
 *
 * Env parsing happens at runtime, so validation errors will bubble and prevent startup.
 */

import { z } from "zod";

export const EnvSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Auth
  MASTER_KEY: z.string().min(1).describe("Used for administrative API access"),

  // LLM
  OPENAI_API_KEY: z.string().min(1),

  // Service URLs
  HARNESS_BASE_URL: z.string().url(),
  LAP_BASE_URL: z.string().url(),
  WEBSOCKET_SERVER_URL: z.string().url().optional(),

  // Platform auth tokens (for managed agents)
  LAP_ACCESS_TOKEN: z.string().min(1),

  // Inference configuration
  MODEL_SERVER: z
    .enum(["openai", "replicate", "custom"])
    .default("openai")
    .describe("Which service to use for inference"),
  INFERENCE_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  INFERENCE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),

  // Harness configuration
  HARNESS_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  HARNESS_IDLE_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  HARNESS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),

  // Memory backend
  MEMORY_BACKEND: z
    .enum(["postgres", "redis"])
    .default("postgres")
    .describe("Storage backend for agent memory"),

  // Optional: Redis connection (only if MEMORY_BACKEND="redis")
  REDIS_URL: z.string().url().optional(),

  // Optional: session archive (Parquet on S3)
  SESSION_ARCHIVE_BUCKET: z.string().optional(),
  SESSION_ARCHIVE_REGION: z.string().default("us-east-1"),

  // Optional: session streaming (WebSocket or file-based)
  SESSION_STREAMING_MODE: z
    .enum(["websocket", "file"])
    .optional()
    .describe("How to stream session updates"),

  // Kubernetes awareness
  IS_KUBERNETES: z.coerce
    .boolean()
    .default(false)
    .describe("Set to true when running inside a Kubernetes cluster"),

  // Agent resource limits
  AGENT_MAX_MEMORY_MB: z.coerce.number().int().min(256).default(4096),
  AGENT_MAX_CPU_CORES: z.coerce
    .number()
    .min(0.1)
    .default(2)
    .describe("e.g. 0.5 for 500m, 2 for 2 CPU"),

  // Database connection pooling
  DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(20),
  DB_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(30),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(5000),

  // Logging
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info")
    .describe("Minimum log level to output"),

  // Session management
  SESSION_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .default(30)
    .describe("How long to keep session data before archival/cleanup"),

  // Cache TTLs
  CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(3600)
    .describe("Default cache lifetime for agent configs, etc."),

  // Tracing (optional)
  OTEL_COLLECTOR_URL: z.string().url().optional(),
  OTEL_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  // Worker pool sizing
  WORKER_POOL_MIN: z.coerce
    .number()
    .int()
    .min(1)
    .default(2)
    .describe("Minimum number of harness worker processes"),
  WORKER_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .default(10)
    .describe("Maximum number of harness worker processes"),

  // Node heartbeat interval
  HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(5000)
    .describe("How often harness nodes report their state"),

  // Interrupt monitoring
  INTERRUPT_CHECK_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(500),
  INTERRUPT_STALE_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(30000)
    .describe("How long before an interrupt request is considered stale"),

  // Tool invocation limits
  MAX_TOOL_INVOCATIONS_PER_SESSION: z.coerce
    .number()
    .int()
    .min(1)
    .default(1000),

  // Rate limiting per agent
  RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).default(100),

  // Request timeout for all API calls
  API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),

  // Memory cleanup job
  MEMORY_CLEANUP_INTERVAL_HOURS: z.coerce.number().int().min(1).default(24),

  // S3 artifact storage configuration — optional for agents to return files
  ARTIFACT_STORAGE: z.enum(["s3"]).optional(),
  AWS_S3_BUCKET: z.string().min(1).optional(),
  AWS_REGION: z.string().default("us-east-1"),
});

function collectContainerEnvPassthrough(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};

  // Collect all vars that don't have explicit schema fields
  // This allows passing secrets/config that the app doesn't explicitly define
  const schemaKeys = new Set(Object.keys(EnvSchema.shape));

  for (const [key, value] of Object.entries(source)) {
    // Skip known node/system vars and our schema keys
    if (
      !schemaKeys.has(key) &&
      !key.startsWith("npm_") &&
      !key.startsWith("NODE_") &&
      !key.match(/^(PATH|HOME|SHELL|TERM|USER|PWD|LANG)$/)
    ) {
      if (value !== undefined) result[key] = value;
    }
  }

  return result;
}

export type ServerEnv = z.infer<typeof EnvSchema>;

export const env: ServerEnv = (() => {
  try {
    return EnvSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("Invalid server environment configuration:");
      error.errors.forEach((err) => {
        console.error(`  ${err.path.join(".")} — ${err.message}`);
      });
    }
    process.exit(1);
  }
})();

// Store passthrough vars on env so they're available at runtime
Object.assign(env, collectContainerEnvPassthrough(process.env));
