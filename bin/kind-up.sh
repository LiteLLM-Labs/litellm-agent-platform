#!/usr/bin/env bash
#
# Idempotent local Kubernetes setup for SANDBOX_BACKEND=k8s development.
#
# What it does (in order):
#   1. Creates a kind cluster named `agent-sbx` if absent. The cluster is
#      configured with extraPortMappings covering the NodePort range
#      30000-30099 so the web container can reach per-Sandbox NodePort
#      services via host.docker.internal:<port>. Must match
#      K8S_NODEPORT_MIN / K8S_NODEPORT_MAX in .env.
#   2. Patches the kubeconfig server URL to host.docker.internal so the same
#      kubeconfig works from both the host (next dev) and inside the
#      docker-compose web/worker containers.
#   3. Installs the kubernetes-sigs/agent-sandbox controller (v0.4.5).
#   4. Loads the local opencode-sandbox:dev image into the kind cluster
#      (needed because K8S_IMAGE_PULL_POLICY defaults to Never).
#
# Re-running is safe — every step short-circuits when the desired state is
# already present.

set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-agent-sbx}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.4.5}"
HARNESS_IMAGE="${HARNESS_IMAGE:-opencode-sandbox:dev}"
NODEPORT_MIN="${K8S_NODEPORT_MIN:-30000}"
NODEPORT_MAX="${K8S_NODEPORT_MAX:-30099}"
# Pin the kind apiserver to a known port so docker-compose containers can
# reach it deterministically at https://host.docker.internal:${API_PORT}.
# Without this, kind picks a random ephemeral port that the web/worker env
# would have to be re-templated against on every cluster recreate.
API_PORT="${K8S_API_PORT:-6444}"

err() { printf "[kind-up] error: %s\n" "$*" >&2; exit 1; }
info() { printf "[kind-up] %s\n" "$*"; }

command -v kind >/dev/null    || err "kind not installed (brew install kind)"
command -v kubectl >/dev/null || err "kubectl not installed"
command -v docker >/dev/null  || err "docker not installed"

# ---- 1. Cluster ----------------------------------------------------------
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  info "cluster '$CLUSTER_NAME' already exists; skipping create"
else
  info "creating cluster '$CLUSTER_NAME' with NodePort range $NODEPORT_MIN-$NODEPORT_MAX"
  config=$(mktemp)
  trap 'rm -f "$config"' EXIT

  {
    echo "kind: Cluster"
    echo "apiVersion: kind.x-k8s.io/v1alpha4"
    # Bind the apiserver to a fixed host port. The cert SANs kind generates
    # cover 127.0.0.1, localhost, AND the docker network gateway, so we keep
    # the TLS verify path; the container side just dials host.docker.internal
    # which Docker Desktop / extra_hosts maps to the host.
    echo "networking:"
    echo "  apiServerAddress: 0.0.0.0"
    echo "  apiServerPort: $API_PORT"
    echo "nodes:"
    echo "- role: control-plane"
    # Pin Kubernetes' service-node-port-range to the same window we expose
    # via extraPortMappings. Without this, k8s allocates NodePorts from the
    # default 30000-32767 range and most assignments would land on ports we
    # never opened on the host.
    echo "  kubeadmConfigPatches:"
    echo "  - |"
    echo "    kind: ClusterConfiguration"
    echo "    apiServer:"
    echo "      extraArgs:"
    echo "        service-node-port-range: \"$NODEPORT_MIN-$NODEPORT_MAX\""
    echo "  extraPortMappings:"
    for port in $(seq "$NODEPORT_MIN" "$NODEPORT_MAX"); do
      echo "  - { containerPort: $port, hostPort: $port, protocol: TCP }"
    done
  } > "$config"

  kind create cluster --name "$CLUSTER_NAME" --config "$config" --wait 90s
fi

ctx="kind-${CLUSTER_NAME}"
# Sanity: confirm the API port matches what the container side will dial.
current_server=$(kubectl config view --raw -o jsonpath="{.clusters[?(@.name=='${ctx}')].cluster.server}")
case "$current_server" in
  *":${API_PORT}")
    info "kubeconfig server pinned at $current_server"
    ;;
  *)
    info "warning: kubeconfig server is $current_server (expected port $API_PORT)"
    ;;
esac

# ---- 3. Controller -------------------------------------------------------
manifest="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
if kubectl --context "$ctx" get deploy -n agent-sandbox-system agent-sandbox-controller >/dev/null 2>&1; then
  info "agent-sandbox controller already installed; skipping apply"
else
  info "installing agent-sandbox ${AGENT_SANDBOX_VERSION}"
  kubectl --context "$ctx" apply -f "$manifest"
  kubectl --context "$ctx" -n agent-sandbox-system rollout status \
    deployment/agent-sandbox-controller --timeout=180s
fi

# ---- 4. Image load -------------------------------------------------------
if ! docker image inspect "$HARNESS_IMAGE" >/dev/null 2>&1; then
  err "image '$HARNESS_IMAGE' not present locally — build it first or set HARNESS_IMAGE"
fi

# kind keeps a cache of loaded image IDs; only load if the cluster's node
# doesn't already have the image with the matching ID.
local_id=$(docker image inspect "$HARNESS_IMAGE" --format '{{.Id}}')
node_has_image=$(docker exec "${CLUSTER_NAME}-control-plane" \
  crictl images -q 2>/dev/null | grep -F "${local_id#sha256:}" || true)
if [ -n "$node_has_image" ]; then
  info "image '$HARNESS_IMAGE' already present on node; skipping load"
else
  info "loading image '$HARNESS_IMAGE' into cluster"
  kind load docker-image "$HARNESS_IMAGE" --name "$CLUSTER_NAME"
fi

cat <<EOF

[kind-up] done.

Cluster:      $ctx
Namespace:    default (override with K8S_NAMESPACE)
NodePort:     $NODEPORT_MIN-$NODEPORT_MAX (mapped to host)
API server:   https://127.0.0.1:$API_PORT (host) / https://host.docker.internal:$API_PORT (container)
Image:        $HARNESS_IMAGE

Set in your .env:
  SANDBOX_BACKEND=k8s
  K8S_HARNESS_IMAGE=$HARNESS_IMAGE
  # for next dev on host:
  K8S_NODE_HOST=127.0.0.1
  # for docker-compose web/worker:
  K8S_NODE_HOST=host.docker.internal
  K8S_API_SERVER=https://host.docker.internal:$API_PORT
  # required when overriding K8S_API_SERVER against kind — the kind apiserver
  # cert SAN won't cover host.docker.internal. NEVER set this against prod.
  K8S_SKIP_TLS_VERIFY=true

Tear down with:
  kind delete cluster --name $CLUSTER_NAME
EOF
