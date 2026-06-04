/**
 * GET /api/v1/managed_agents/sessions/[session_id]/diagnose
 *
 * One-shot bundle of every signal needed to debug a stuck or slow session.
 *
 * The everyday failure mode this exists to fix: a user pings the engineer
 * about a session, the engineer runs ~10 commands (LAP API for the row, kubectl
 * for pod/services/logs, admin/stats for the warm pool, Render API for
 * platform logs) and reconciles by hand. This endpoint does it in one call
 * and runs a deterministic ruleset over the gathered data to surface the
 * common patterns we've already seen — dead node, stuck node-host cache,
 * unreachable harness, oversubscribed node, missing service, etc.
 *
 * Read-only. Worst-case latency budget ~5s on a healthy session; each k8s
 * call has a hard 15s timeout so an apiserver hiccup can't wedge the
 * endpoint. NotFound on any individual section is recorded as
 * `{ exists: false }` rather than aborting the whole response — partial
 * data is more useful than a 500.
 */

import * as k8s from "@kubernetes/client-node";
import { fetch } from "undici";

import { assertAuth } from "@/api/auth";
import { prisma } from "@/api/db";
import { env } from "@/api/env";
import { wrap } from "@/api/route-helpers";
import { httpError } from "@/api/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const K8S_CALL_TIMEOUT_MS = 15_000;
const HARNESS_PROBE_TIMEOUT_MS = 2_000;
const POD_LOG_TAIL_LINES = 200;

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";
const HARNESS_CONTAINER_NAME = "harness";
const PREPULL_DAEMONSET_NAME = "harness-image-prepull";

// Thresholds for the ruleset. Tuned from the failure modes we've actually
// seen: 120s in `creating` is well past p99 of a healthy spawn (~10-20s),
// 180s not-Ready is past the worst legitimate ImagePulling window we've
// observed in EKS without aggressive prepull.
const STUCK_CREATING_THRESHOLD_MS = 120_000;
const NOT_READY_THRESHOLD_MS = 180_000;
const NODE_OVERSUBSCRIPTION_PCT = 150;

// Independent k8s client — we mirror the lazy pattern in src/api/k8s.ts
// instead of importing private helpers from it, so changes to the sandbox
// client don't accidentally rewire the diagnostic path.
let _core: k8s.CoreV1Api | null = null;
let _custom: k8s.CustomObjectsApi | null = null;
let _apps: k8s.AppsV1Api | null = null;

function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBE_CONFIG_B64) {
    const yaml = Buffer.from(process.env.KUBE_CONFIG_B64, "base64").toString(
      "utf8",
    );
    kc.loadFromString(yaml);
  } else if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    kc.loadFromDefault();
  }
  const override = env.K8S_API_SERVER;
  if (override && override.length > 0) {
    const ctx = kc.getCurrentContext();
    const ctxObj = kc.getContextObject(ctx);
    if (ctxObj?.cluster) {
      const cluster = kc.getCluster(ctxObj.cluster);
      if (cluster) {
        const skipTLS = env.K8S_SKIP_TLS_VERIFY;
        const patched: k8s.Cluster = {
          ...cluster,
          server: override,
          ...(skipTLS
            ? { skipTLSVerify: true, caData: undefined, caFile: undefined }
            : {}),
        };
        kc.loadFromOptions({
          clusters: [
            patched,
            ...kc.getClusters().filter((c) => c.name !== cluster.name),
          ],
          users: kc.getUsers(),
          contexts: kc.getContexts(),
          currentContext: ctx,
        });
      }
    }
  }
  return kc;
}

function coreApi(): k8s.CoreV1Api {
  if (_core === null) _core = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
  return _core;
}

function customApi(): k8s.CustomObjectsApi {
  if (_custom === null)
    _custom = loadKubeConfig().makeApiClient(k8s.CustomObjectsApi);
  return _custom;
}

function appsApi(): k8s.AppsV1Api {
  if (_apps === null) _apps = loadKubeConfig().makeApiClient(k8s.AppsV1Api);
  return _apps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code =
    (err as { code?: number; statusCode?: number }).code
    ?? (err as { code?: number; statusCode?: number }).statusCode;
  return code === 404;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Wrap a k8s call with a hard timeout. Returns the resolved value, a
 * `{ notFound: true }` sentinel for 404s, or `{ error }` for anything else.
 * The caller decides how to render each shape — we never throw across the
 * section boundary because one stuck section shouldn't fail the whole
 * diagnose response.
 */
type SectionResult<T> =
  | { ok: true; value: T }
  | { notFound: true }
  | { error: string };

async function tryK8s<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<SectionResult<T>> {
  try {
    const value = await Promise.race<T>([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${label} timed out after ${K8S_CALL_TIMEOUT_MS}ms`)),
          K8S_CALL_TIMEOUT_MS,
        ),
      ),
    ]);
    return { ok: true, value };
  } catch (err) {
    if (isNotFound(err)) return { notFound: true };
    return { error: errMessage(err) };
  }
}

function ageMs(start: Date | string | null | undefined): number | null {
  if (!start) return null;
  const ts = typeof start === "string" ? new Date(start) : start;
  if (Number.isNaN(ts.getTime())) return null;
  return Date.now() - ts.getTime();
}

// Parse a kubernetes resource quantity ("100m", "256Mi", "1Gi", "1.5", "500k")
// into a normalized scalar — CPU in millicores, memory in bytes. Returns
// null for empty / unparseable values; the caller should skip those nodes
// rather than over- or under-counting.
function parseCpu(q: string | undefined | null): number | null {
  if (!q) return null;
  if (q.endsWith("m")) {
    const n = Number(q.slice(0, -1));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(q);
  return Number.isFinite(n) ? n * 1000 : null;
}

const MEMORY_UNITS: Record<string, number> = {
  "": 1,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
};

function parseMemory(q: string | undefined | null): number | null {
  if (!q) return null;
  const m = /^(\d+(?:\.\d+)?)([KMGT]i?|)$/.exec(q);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = MEMORY_UNITS[m[2]] ?? null;
  if (unit === null || !Number.isFinite(n)) return null;
  return n * unit;
}

// ---------------------------------------------------------------------------
// Section gatherers
// ---------------------------------------------------------------------------

interface PodSection {
  exists: boolean;
  phase?: string;
  pod_ip?: string;
  pod_ips?: string[];
  node_name?: string;
  age_ms?: number;
  restart_count?: number;
  container_statuses?: Array<{
    name: string;
    ready: boolean;
    restart_count: number;
    waiting_reason?: string;
    waiting_message?: string;
    terminated_reason?: string;
    terminated_exit_code?: number;
  }>;
  conditions?: Array<{ type: string; status: string; reason?: string }>;
  error?: string;
}

function projectPod(pod: k8s.V1Pod): PodSection {
  const statuses = pod.status?.containerStatuses ?? [];
  return {
    exists: true,
    phase: pod.status?.phase,
    pod_ip: pod.status?.podIP,
    pod_ips: pod.status?.podIPs?.map((p) => p.ip).filter((ip): ip is string =>
      typeof ip === "string",
    ),
    node_name: pod.spec?.nodeName,
    age_ms: ageMs(pod.metadata?.creationTimestamp ?? null) ?? undefined,
    restart_count: statuses.reduce(
      (acc, s) => acc + (s.restartCount ?? 0),
      0,
    ),
    container_statuses: statuses.map((s) => ({
      name: s.name,
      ready: Boolean(s.ready),
      restart_count: s.restartCount ?? 0,
      waiting_reason: s.state?.waiting?.reason,
      waiting_message: s.state?.waiting?.message,
      terminated_reason: s.state?.terminated?.reason,
      terminated_exit_code: s.state?.terminated?.exitCode,
    })),
    conditions: (pod.status?.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason,
    })),
  };
}

interface SandboxCRSection {
  exists: boolean;
  age_ms?: number;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
  pod_ips?: string[];
  service?: string;
  raw_status?: unknown;
  error?: string;
}

interface SandboxCRPayload {
  metadata?: { creationTimestamp?: string };
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    podIPs?: Array<{ ip?: string }>;
    service?: string;
  };
}

function projectSandboxCR(cr: SandboxCRPayload): SandboxCRSection {
  const status = cr.status ?? {};
  return {
    exists: true,
    age_ms: ageMs(cr.metadata?.creationTimestamp ?? null) ?? undefined,
    conditions: (status.conditions ?? [])
      .filter((c): c is { type: string; status: string; reason?: string; message?: string } =>
        typeof c.type === "string" && typeof c.status === "string",
      )
      .map((c) => ({
        type: c.type,
        status: c.status,
        reason: c.reason,
        message: c.message,
      })),
    pod_ips: status.podIPs
      ?.map((p) => p.ip)
      .filter((ip): ip is string => typeof ip === "string"),
    service: status.service,
    raw_status: status,
  };
}

interface ServiceSection {
  exists: boolean;
  cluster_ip?: string;
  age_ms?: number;
  ports?: Array<{ port?: number; target_port?: unknown; node_port?: number; protocol?: string }>;
  node_port?: number;
  error?: string;
}

function projectService(svc: k8s.V1Service): ServiceSection {
  const port = svc.spec?.ports?.[0]?.nodePort;
  return {
    exists: true,
    cluster_ip: svc.spec?.clusterIP,
    age_ms: ageMs(svc.metadata?.creationTimestamp ?? null) ?? undefined,
    ports: (svc.spec?.ports ?? []).map((p) => ({
      port: p.port,
      target_port: p.targetPort,
      node_port: p.nodePort,
      protocol: p.protocol,
    })),
    node_port: typeof port === "number" ? port : undefined,
  };
}

interface NodeSection {
  exists: boolean;
  name?: string;
  ready_status?: string;
  ready_reason?: string;
  internal_ip?: string;
  external_ip?: string;
  age_ms?: number;
  taints?: Array<{ key: string; value?: string; effect: string }>;
  capacity?: { cpu_millicores: number | null; memory_bytes: number | null };
  allocatable?: { cpu_millicores: number | null; memory_bytes: number | null };
  allocated_requests?: { cpu_millicores: number; memory_bytes: number };
  allocated_pct?: { cpu: number | null; memory: number | null };
  pod_count?: number;
  error?: string;
}

interface ImageCacheSection {
  daemonset_exists: boolean;
  ready_on_pod_node?: boolean;
  daemonset_ready_count?: number;
  daemonset_desired_count?: number;
  notes?: string;
  error?: string;
}

interface WarmPoolSection {
  provisioning: number;
  warm: number;
  claimed: number;
  dead: number;
}

interface DetectedIssue {
  code: string;
  severity: "high" | "med" | "info";
  message: string;
  recommended_action?: string;
}

// ---------------------------------------------------------------------------
// Detection ruleset
// ---------------------------------------------------------------------------

interface DetectionInput {
  session: {
    status: string;
    sandbox_url: string | null;
    age_ms: number | null;
  };
  pod: PodSection | null;
  service: ServiceSection | null;
  node: NodeSection | null;
  image_cache: ImageCacheSection | null;
  warm_pool: WarmPoolSection;
  harness_probe: { reachable: boolean; status?: number; error?: string } | null;
}

function detectIssues(input: DetectionInput): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  // dead_node_assigned: pod is scheduled on a node whose Ready status is not "True".
  // This was the session c756a2e2 failure mode — pod sitting on a NotReady node, never moves.
  if (
    input.pod?.exists
    && input.node?.exists
    && input.node.ready_status
    && input.node.ready_status !== "True"
  ) {
    issues.push({
      code: "dead_node_assigned",
      severity: "high",
      message: `Pod scheduled on node ${input.node.name ?? "?"} whose Ready=${input.node.ready_status} (reason: ${input.node.ready_reason ?? "?"})`,
      recommended_action:
        "Cordon and drain the node, then delete the pod so the controller reschedules it onto a Ready node.",
    });
  }

  // stale_node_host_cache_suspect: session creating for >120s, pod Running, service has NodePort,
  // but sandbox_url is still null. Implies the platform's _nodeHostCache returned a dead IP and
  // the URL got stuck. Restart the platform.
  if (
    input.session.status === "creating"
    && input.session.age_ms !== null
    && input.session.age_ms > STUCK_CREATING_THRESHOLD_MS
    && input.pod?.phase === "Running"
    && typeof input.service?.node_port === "number"
    && !input.session.sandbox_url
  ) {
    issues.push({
      code: "stale_node_host_cache_suspect",
      severity: "high",
      message: `Session has been creating for ${Math.round(input.session.age_ms / 1000)}s but sandbox_url is still null even though pod is Running and the NodePort service exists.`,
      recommended_action:
        "Likely _nodeHostCache stuck on a dead node IP. Restart the platform service (kubectl rollout restart) to flush the cache.",
    });
  }

  // pod_image_pull_backoff: container reports ImagePullBackOff / ErrImagePull / ErrImageNeverPull.
  const badPullReasons = new Set([
    "ImagePullBackOff",
    "ErrImagePull",
    "ErrImageNeverPull",
  ]);
  const pullStuck = (input.pod?.container_statuses ?? []).find((c) =>
    c.waiting_reason ? badPullReasons.has(c.waiting_reason) : false,
  );
  if (pullStuck) {
    issues.push({
      code: "pod_image_pull_backoff",
      severity: "high",
      message: `Container ${pullStuck.name} is in ${pullStuck.waiting_reason}: ${pullStuck.waiting_message ?? ""}`,
      recommended_action:
        "Verify K8S_HARNESS_IMAGE is correct and the node has registry credentials. If using a private registry, check the imagePullSecret.",
    });
  }

  // pod_not_ready_old: pod has existed >180s and is not Ready.
  if (
    input.pod?.exists
    && typeof input.pod.age_ms === "number"
    && input.pod.age_ms > NOT_READY_THRESHOLD_MS
  ) {
    const allReady = (input.pod.container_statuses ?? []).every((c) => c.ready);
    if (!allReady) {
      issues.push({
        code: "pod_not_ready_old",
        severity: "med",
        message: `Pod has been not-Ready for ${Math.round(input.pod.age_ms / 1000)}s. Check container_statuses for waiting/terminated reasons and pod_logs_tail.`,
      });
    }
  }

  // harness_unreachable: pod Running, NodePort assigned, but a direct HTTP probe to the node:port
  // got no response. Distinct from "container crashed" because the probe target is the host-side
  // route the platform actually uses.
  if (
    input.pod?.phase === "Running"
    && typeof input.service?.node_port === "number"
    && input.harness_probe
    && !input.harness_probe.reachable
  ) {
    issues.push({
      code: "harness_unreachable",
      severity: "high",
      message: `Pod is Running and NodePort ${input.service.node_port} is assigned but HTTP probe failed: ${input.harness_probe.error ?? "no response"}`,
      recommended_action:
        "Inspect pod_logs_tail to confirm the harness bound to PORT. Verify the node SecurityGroup / firewall opens the NodePort range.",
    });
  }

  // node_oversubscribed: allocated CPU or memory > 150% of capacity. Schedulable but realistically
  // contended — sandboxes will starve.
  if (
    input.node?.allocated_pct?.cpu !== null
    && input.node?.allocated_pct?.cpu !== undefined
    && input.node.allocated_pct.cpu > NODE_OVERSUBSCRIPTION_PCT
  ) {
    issues.push({
      code: "node_oversubscribed",
      severity: "med",
      message: `Node ${input.node.name ?? "?"} CPU requests are ${input.node.allocated_pct.cpu}% of capacity.`,
    });
  } else if (
    input.node?.allocated_pct?.memory !== null
    && input.node?.allocated_pct?.memory !== undefined
    && input.node.allocated_pct.memory > NODE_OVERSUBSCRIPTION_PCT
  ) {
    issues.push({
      code: "node_oversubscribed",
      severity: "med",
      message: `Node ${input.node.name ?? "?"} memory requests are ${input.node.allocated_pct.memory}% of capacity.`,
    });
  }

  // service_missing: pod exists but the -np Service does not. Not applicable in-cluster
  // (NodePort Service is intentionally skipped; routing uses headless DNS instead).
  if (input.pod?.exists && input.service && !input.service.exists && env.IN_CLUSTER !== "true") {
    issues.push({
      code: "service_missing",
      severity: "high",
      message:
        "Pod exists but its NodePort Service is missing. There is no host-side route to the harness.",
      recommended_action:
        "Delete the session and let it respawn — runTask creates both Sandbox and Service together.",
    });
  }

  // warm_pool_empty_for_agent: WARM_POOL_SIZE > 0 yet this agent has 0 warm rows. Surfaces an
  // agent whose warm provisioner is stuck (e.g. all rows died and the reconciler hasn't recreated
  // them) — sessions for it will pay full spawn latency.
  if (
    env.WARM_POOL_SIZE > 0
    && input.warm_pool.warm === 0
    && input.warm_pool.provisioning === 0
  ) {
    issues.push({
      code: "warm_pool_empty_for_agent",
      severity: "info",
      message: `Agent has 0 warm and 0 provisioning rows but WARM_POOL_SIZE=${env.WARM_POOL_SIZE}. Next session for this agent will cold-spawn.`,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const GET = wrap(async (req: Request, ctx: { params: Promise<{ session_id: string }> }) => {
  assertAuth(req);
  const { session_id } = await ctx.params;

  const session = await prisma.session.findUnique({ where: { session_id } });
  if (!session) httpError(404, `session ${session_id} not found`);

  const agent = await prisma.agent.findUnique({
    where: { agent_id: session.agent_id },
    select: {
      agent_id: true,
      agent_name: true,
      harness_id: true,
      model: true,
      repo_url: true,
      branch: true,
    },
  });

  const ns = env.K8S_NAMESPACE;
  const taskArn = session.task_arn;
  const isBrainInline = agent?.harness_id === "claude-code-brain-inline";

  // For brain-inline sessions: look up the shared harness pod by label selector
  // instead of task_arn (which is null — no per-session pod). The executor pod
  // (if any) is found via litellm-session-id label.
  const brainInlinePodResult = isBrainInline
    ? await tryK8s("brain-inline-harness pod", async () => {
        const list = await coreApi().listNamespacedPod({
          namespace: ns,
          labelSelector: "app=brain-inline-harness",
        });
        const items = ((list as unknown as { body?: { items: k8s.V1Pod[] } }).body?.items
          ?? (list as unknown as { items: k8s.V1Pod[] }).items ?? []) as k8s.V1Pod[];
        const running = items.find(
          (p) => !p.metadata?.deletionTimestamp && p.status?.phase === "Running",
        );
        if (!running) throw new Error("no running brain-inline-harness pod found");
        return running;
      })
    : null;

  // For brain-inline: also look up the executor pod by session label.
  const executorPodResult = isBrainInline
    ? await tryK8s("executor pod", () =>
        coreApi().listNamespacedPod({
          namespace: ns,
          labelSelector: `litellm-session-id=${session.session_id}`,
        }).then((list) => {
          const items = ((list as unknown as { body?: { items: k8s.V1Pod[] } }).body?.items
            ?? (list as unknown as { items: k8s.V1Pod[] }).items ?? []) as k8s.V1Pod[];
          const pod = items.find((p) => p.status?.phase !== "Succeeded");
          if (!pod) throw new Error("no executor pod found for session");
          return pod;
        }),
      )
    : null;

  // Fan out all the k8s reads + warm-pool aggregation in parallel. Each one is
  // independently failure-tolerant — a NotFound or transient apiserver error
  // on one section never aborts the others.
  const [
    podResult,
    sandboxCRResult,
    serviceResult,
    podLogsResult,
    warmCounts,
  ] = await Promise.all([
    // For brain-inline, use the shared harness pod result; for sandbox sessions use task_arn.
    isBrainInline
      ? (brainInlinePodResult ?? Promise.resolve<SectionResult<k8s.V1Pod>>({ notFound: true }))
      : taskArn
        ? tryK8s("pod", () =>
            coreApi().readNamespacedPod({ name: taskArn, namespace: ns }),
          )
        : Promise.resolve<SectionResult<k8s.V1Pod>>({ notFound: true }),
    taskArn
      ? tryK8s<SandboxCRPayload>("sandbox CR", () =>
          customApi().getNamespacedCustomObject({
            group: SANDBOX_GROUP,
            version: SANDBOX_VERSION,
            namespace: ns,
            plural: SANDBOX_PLURAL,
            name: taskArn,
          }) as Promise<SandboxCRPayload>,
        )
      : Promise.resolve<SectionResult<SandboxCRPayload>>({ notFound: true }),
    taskArn
      ? tryK8s("service", () =>
          coreApi().readNamespacedService({
            name: `${taskArn}-np`,
            namespace: ns,
          }),
        )
      : Promise.resolve<SectionResult<k8s.V1Service>>({ notFound: true }),
    // For brain-inline, fetch logs from the shared harness pod.
    isBrainInline && "ok" in (brainInlinePodResult ?? {})
      ? tryK8s("pod logs", () =>
          coreApi().readNamespacedPodLog({
            name: ((brainInlinePodResult as { ok: true; value: k8s.V1Pod }).value).metadata!.name!,
            namespace: ns,
            container: HARNESS_CONTAINER_NAME,
            tailLines: POD_LOG_TAIL_LINES,
          }),
        )
      : taskArn
        ? tryK8s("pod logs", () =>
            coreApi().readNamespacedPodLog({
              name: taskArn,
              namespace: ns,
              container: HARNESS_CONTAINER_NAME,
              tailLines: POD_LOG_TAIL_LINES,
            }),
          )
        : Promise.resolve<SectionResult<string>>({ notFound: true }),
    prisma.warmTask.groupBy({
      by: ["status"],
      where: { agent_id: session.agent_id },
      _count: { _all: true },
    }),
  ]);

  // Project pod first — we need pod.spec.nodeName before we can fetch the node.
  const pod: PodSection | null = (() => {
    if ("ok" in podResult) return projectPod(podResult.value);
    if ("notFound" in podResult) return { exists: false };
    return { exists: false, error: podResult.error };
  })();

  const nodeName = pod?.node_name;
  const nodePort = (() => {
    if ("ok" in serviceResult) {
      const p = serviceResult.value.spec?.ports?.[0]?.nodePort;
      return typeof p === "number" ? p : null;
    }
    return null;
  })();

  // Second-stage parallel fan-out: node read, pods-on-node listing for
  // request totals, prepull DaemonSet check. All depend on `nodeName` /
  // `nodePort` from the first wave, so they have to come after it. The
  // harness HTTP probe is built in a third stage below because it depends
  // on the resolved node's ExternalIP — chaining it inline here wouldn't
  // see the resolved value (Promise.all evaluates the array eagerly).
  const [nodeRes, podsOnNodeRes, prepullRes] = await Promise.all([
    nodeName
      ? tryK8s("node", () => coreApi().readNode({ name: nodeName }))
      : Promise.resolve<SectionResult<k8s.V1Node>>({ notFound: true }),
    nodeName
      ? tryK8s("pods on node", () =>
          coreApi().listPodForAllNamespaces({
            fieldSelector: `spec.nodeName=${nodeName}`,
          }),
        )
      : Promise.resolve<SectionResult<k8s.V1PodList>>({ notFound: true }),
    tryK8s("prepull daemonset", () =>
      appsApi().readNamespacedDaemonSet({
        name: PREPULL_DAEMONSET_NAME,
        namespace: ns,
      }),
    ),
  ]);

  const node: NodeSection | null = (() => {
    if ("ok" in nodeRes) {
      const n = nodeRes.value;
      const ready = (n.status?.conditions ?? []).find(
        (c) => c.type === "Ready",
      );
      const addrs = n.status?.addresses ?? [];
      const capacity = n.status?.capacity ?? {};
      const allocatable = n.status?.allocatable ?? {};
      return {
        exists: true,
        name: n.metadata?.name,
        ready_status: ready?.status,
        ready_reason: ready?.reason,
        internal_ip: addrs.find((a) => a.type === "InternalIP")?.address,
        external_ip: addrs.find((a) => a.type === "ExternalIP")?.address,
        age_ms: ageMs(n.metadata?.creationTimestamp ?? null) ?? undefined,
        taints: (n.spec?.taints ?? []).map((t) => ({
          key: t.key,
          value: t.value,
          effect: t.effect,
        })),
        capacity: {
          cpu_millicores: parseCpu(capacity["cpu"] ?? null),
          memory_bytes: parseMemory(capacity["memory"] ?? null),
        },
        allocatable: {
          cpu_millicores: parseCpu(allocatable["cpu"] ?? null),
          memory_bytes: parseMemory(allocatable["memory"] ?? null),
        },
      };
    }
    if ("notFound" in nodeRes) return { exists: false };
    return { exists: false, error: nodeRes.error };
  })();

  // Sum request totals across every pod on the node. We do this in-process
  // because the apiserver doesn't expose a "current requests on node" field;
  // every kubelet-aware tool (kubectl describe node, k9s) computes it the same way.
  if (node && node.exists && "ok" in podsOnNodeRes) {
    let cpuMillicores = 0;
    let memoryBytes = 0;
    let podCount = 0;
    for (const p of podsOnNodeRes.value.items ?? []) {
      podCount += 1;
      for (const c of p.spec?.containers ?? []) {
        const cpu = parseCpu(c.resources?.requests?.["cpu"] ?? null);
        const mem = parseMemory(c.resources?.requests?.["memory"] ?? null);
        if (cpu !== null) cpuMillicores += cpu;
        if (mem !== null) memoryBytes += mem;
      }
    }
    node.allocated_requests = {
      cpu_millicores: cpuMillicores,
      memory_bytes: memoryBytes,
    };
    node.pod_count = podCount;
    node.allocated_pct = {
      cpu:
        node.capacity?.cpu_millicores && node.capacity.cpu_millicores > 0
          ? Math.round((cpuMillicores / node.capacity.cpu_millicores) * 100)
          : null,
      memory:
        node.capacity?.memory_bytes && node.capacity.memory_bytes > 0
          ? Math.round((memoryBytes / node.capacity.memory_bytes) * 100)
          : null,
    };
  }

  // Image cache check — DaemonSet present? If yes, is it Ready on this node?
  // If the DaemonSet doesn't exist at all (the common case in this repo today)
  // we say so plainly so the operator doesn't waste time chasing it.
  const imageCache: ImageCacheSection = (() => {
    if ("notFound" in prepullRes) {
      return {
        daemonset_exists: false,
        notes: `DaemonSet ${PREPULL_DAEMONSET_NAME} not found in namespace ${ns}. Image is pulled on demand at pod scheduling time.`,
      };
    }
    if ("error" in prepullRes) {
      return { daemonset_exists: false, error: prepullRes.error };
    }
    const ds = prepullRes.value;
    const ready = ds.status?.numberReady ?? 0;
    const desired = ds.status?.desiredNumberScheduled ?? 0;
    // Whether the DS pod is Ready on our specific node isn't directly on the
    // DaemonSet — kubectl describe walks the matching pods. If we already have
    // podsOnNodeRes we can look for a pod owned by this DS on that node.
    let onNodeReady: boolean | undefined;
    if (nodeName && "ok" in podsOnNodeRes) {
      const dsPod = (podsOnNodeRes.value.items ?? []).find((p) =>
        (p.metadata?.ownerReferences ?? []).some(
          (o) => o.kind === "DaemonSet" && o.name === PREPULL_DAEMONSET_NAME,
        ),
      );
      if (dsPod) {
        onNodeReady = (dsPod.status?.containerStatuses ?? []).every(
          (c) => c.ready,
        );
      }
    }
    return {
      daemonset_exists: true,
      ready_on_pod_node: onNodeReady,
      daemonset_ready_count: ready,
      daemonset_desired_count: desired,
    };
  })();

  // Harness probe. We use the node's ExternalIP (or InternalIP fallback)
  // directly rather than going through the platform's cached node host, so
  // this test bypasses the very cache the `stale_node_host_cache_suspect`
  // rule is hunting. Only runs when we have both a resolved node and a
  // NodePort to dial.
  let harnessProbe: { reachable: boolean; status?: number; error?: string } | null = null;
  if ("ok" in nodeRes && typeof nodePort === "number") {
    const addrs = nodeRes.value.status?.addresses ?? [];
    const host =
      addrs.find((a) => a.type === "ExternalIP")?.address
      ?? addrs.find((a) => a.type === "InternalIP")?.address;
    if (host) {
      try {
        const res = await fetch(`http://${host}:${nodePort}/session`, {
          method: "GET",
          signal: AbortSignal.timeout(HARNESS_PROBE_TIMEOUT_MS),
        });
        harnessProbe = { reachable: true, status: res.status };
      } catch (err) {
        harnessProbe = { reachable: false, error: errMessage(err) };
      }
    }
  }

  const service: ServiceSection | null = (() => {
    if ("ok" in serviceResult) return projectService(serviceResult.value);
    if ("notFound" in serviceResult) return { exists: false };
    return { exists: false, error: serviceResult.error };
  })();

  const sandboxCR: SandboxCRSection | null = (() => {
    if ("ok" in sandboxCRResult) return projectSandboxCR(sandboxCRResult.value);
    if ("notFound" in sandboxCRResult) return { exists: false };
    return { exists: false, error: sandboxCRResult.error };
  })();

  const podLogsTail: { available: boolean; text?: string; error?: string } = (() => {
    if ("ok" in podLogsResult) {
      // Some client-node versions wrap the log payload; handle both.
      const v = podLogsResult.value as unknown;
      const text = typeof v === "string"
        ? v
        : ((v as { body?: string })?.body ?? JSON.stringify(v));
      return { available: true, text };
    }
    if ("notFound" in podLogsResult) {
      return {
        available: false,
        error: "pod not found (or container has not started writing logs yet)",
      };
    }
    return { available: false, error: podLogsResult.error };
  })();

  // Warm pool aggregation — mirror admin/stats but scoped to this agent.
  const warmPool: WarmPoolSection = {
    provisioning: 0,
    warm: 0,
    claimed: 0,
    dead: 0,
  };
  for (const g of warmCounts) {
    if (g.status in warmPool) {
      warmPool[g.status as keyof WarmPoolSection] = g._count._all;
    }
  }

  const detectedIssues = detectIssues({
    session: {
      status: session.status,
      sandbox_url: session.sandbox_url,
      age_ms: ageMs(session.created_at),
    },
    pod,
    service,
    node,
    image_cache: imageCache,
    warm_pool: warmPool,
    harness_probe: harnessProbe,
  });

  return Response.json({
    session: {
      session_id: session.session_id,
      agent_id: session.agent_id,
      status: session.status,
      task_arn: session.task_arn,
      sandbox_url: session.sandbox_url,
      failure_reason: session.failure_reason,
      created_at: session.created_at.toISOString(),
      last_seen_at: session.last_seen_at ? session.last_seen_at.toISOString() : null,
      stopped_at: session.stopped_at ? session.stopped_at.toISOString() : null,
      age_ms: ageMs(session.created_at),
    },
    agent,
    pod,
    sandbox_cr: sandboxCR,
    service,
    pod_logs_tail: podLogsTail,
    node,
    image_cache: imageCache,
    warm_pool: warmPool,
    harness_probe: harnessProbe,
    detected_issues: detectedIssues,
    // brain-inline specific: shared harness pod + per-session executor pod
    ...(isBrainInline ? {
      brain_inline: {
        harness_pod: "ok" in (brainInlinePodResult ?? {})
          ? { name: ((brainInlinePodResult as { ok: true; value: k8s.V1Pod }).value).metadata?.name, phase: ((brainInlinePodResult as { ok: true; value: k8s.V1Pod }).value).status?.phase }
          : { exists: false },
        executor_pod: executorPodResult && "ok" in executorPodResult
          ? { name: executorPodResult.value.metadata?.name, phase: executorPodResult.value.status?.phase }
          : { exists: false },
      },
    } : {}),
    // We can't reach Render's log API from inside the deployed platform
    // itself — fetch separately via the Render dashboard or `render logs`.
    notes: {
      platform_logs:
        "Not available from this endpoint. Fetch via Render dashboard filtered by session_id.",
    },
  });
});
