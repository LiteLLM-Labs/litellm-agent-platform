#!/usr/bin/env bash
#
# Provision a sandbox-ready EKS cluster from scratch.
#
# What it does:
#   1. Verifies AWS credentials and required CLIs.
#   2. Creates an EKS cluster (eksctl) with a small managed node group
#      and the NodePort range exposed via a security-group ingress rule.
#   3. Installs the kubernetes-sigs/agent-sandbox controller.
#   4. Maps the caller's IAM principal to system:masters via the aws-auth
#      ConfigMap (idempotent — safe to re-run).
#   5. Writes an exec-plugin kubeconfig to stdout as base64 — paste into
#      KUBE_CONFIG_B64 on Render / Railway. The kubeconfig calls
#      `aws-iam-authenticator token` at every request, so the same AWS
#      credentials already in the deploy env (AWS_ACCESS_KEY_ID /
#      AWS_SECRET_ACCESS_KEY / AWS_REGION) auth to EKS without a baked-in
#      bearer token that would expire after 24h.
#   6. Prints the K8S_NODE_HOST guidance (set to `auto` — the platform
#      discovers a Ready node ExternalIP at spawn time).
#
# Usage:
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \
#     bin/eks-up.sh > kube-config.b64
#
# Optional env:
#   CLUSTER_NAME    default: litellm-agents
#   NODE_TYPE       default: t3.large  (2 vCPU / 8 GiB)
#   NODE_COUNT      default: 2
#   NODE_MAX        default: 4
#   K8S_VERSION     default: 1.30
#   AGENT_SANDBOX_VERSION  default: v0.4.5
#
# Tear down:
#   eksctl delete cluster --name <CLUSTER_NAME> --region <AWS_REGION>

set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-litellm-agents}"
# t3.large: 2 vCPU / 8 GiB. t3.medium (4 GiB) was insufficient — kubelet
# OOMd under modest concurrent sandbox load (~5-8 opencode pods doing
# git clone + sqlite migrate at once). Bump default and let operators
# downsize if their workload is lighter.
NODE_TYPE="${NODE_TYPE:-t3.large}"
# Two nodes by default so a single node failure doesn't take the cluster
# down. Cluster autoscaler can grow up to NODE_MAX (4) if warm pool
# capacity demands it.
NODE_COUNT="${NODE_COUNT:-2}"
NODE_MAX="${NODE_MAX:-4}"
K8S_VERSION="${K8S_VERSION:-1.30}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.4.5}"
NODEPORT_MIN="${K8S_NODEPORT_MIN:-30000}"
NODEPORT_MAX="${K8S_NODEPORT_MAX:-30099}"

err()  { printf "[eks-up] error: %s\n" "$*" >&2; exit 1; }
info() { printf "[eks-up] %s\n" "$*" >&2; }   # logs go to stderr; only the
                                              # base64 kubeconfig hits stdout

# Run any AWS CLI / eksctl / kubectl invocation with stdout redirected to
# stderr — these tools occasionally leak their own progress output to
# stdout, which would corrupt the base64 kubeconfig the caller captures
# at the end. Wrap external commands that aren't producing the final
# stdout payload.
silent() { "$@" >&2; }

# ---- 1. Prereqs ----------------------------------------------------------
command -v aws     >/dev/null || err "aws cli not installed"
command -v eksctl  >/dev/null || err "eksctl not installed (brew install eksctl)"
command -v kubectl >/dev/null || err "kubectl not installed"
command -v jq      >/dev/null || err "jq not installed"

: "${AWS_REGION:?AWS_REGION required}"
CALLER_ARN=$(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null) \
  || err "AWS credentials missing or invalid"
info "running as $CALLER_ARN"

# ---- 2. Cluster ----------------------------------------------------------
if eksctl get cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" \
     >/dev/null 2>&1; then
  info "cluster '$CLUSTER_NAME' already exists; reusing"
else
  info "creating EKS cluster '$CLUSTER_NAME' in $AWS_REGION (~15 min)"
  silent eksctl create cluster \
    --name "$CLUSTER_NAME" \
    --region "$AWS_REGION" \
    --version "$K8S_VERSION" \
    --nodegroup-name default \
    --node-type "$NODE_TYPE" \
    --nodes "$NODE_COUNT" \
    --nodes-min 1 --nodes-max "$NODE_MAX" \
    --managed
fi

# Open the full EKS default NodePort range (30000-32767) on the node
# security group. EKS's apiserver uses its default Service node-port range
# and we don't override it from outside, so allocations land anywhere in
# 30000-32767. Restricting the SG to a subset means most Sandbox spawns
# would assign a port the platform can't reach.
NG_SG=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" \
          --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' \
          --output text)
info "opening NodePort 30000-32767 on $NG_SG"
aws ec2 authorize-security-group-ingress \
  --region "$AWS_REGION" \
  --group-id "$NG_SG" \
  --ip-permissions \
    "IpProtocol=tcp,FromPort=30000,ToPort=32767,IpRanges=[{CidrIp=0.0.0.0/0}]" \
  >/dev/null 2>&1 || true   # idempotent — duplicate rule is fine

# ---- 3. agent-sandbox controller ----------------------------------------
info "installing agent-sandbox $AGENT_SANDBOX_VERSION"
silent kubectl apply -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
silent kubectl -n agent-sandbox-system rollout status \
  deployment/agent-sandbox-controller --timeout=300s

# ---- 4. IAM identity mapping --------------------------------------------
# `aws sts get-caller-identity` returns the *session* ARN for an assumed
# role (e.g. arn:aws:sts::1234:assumed-role/MyRole/session). aws-auth /
# eksctl expect the role's *base* ARN (arn:aws:iam::1234:role/MyRole).
# Normalize before passing to eksctl.
MAPPING_ARN="$CALLER_ARN"
case "$CALLER_ARN" in
  arn:aws:sts::*:assumed-role/*)
    # Strip the trailing session name and rewrite sts → iam.
    role_path=${CALLER_ARN#arn:aws:sts::}      # 1234:assumed-role/MyRole/session
    account=${role_path%%:*}                   # 1234
    rest=${role_path#*:assumed-role/}          # MyRole/session
    role_name=${rest%%/*}                      # MyRole
    MAPPING_ARN="arn:aws:iam::${account}:role/${role_name}"
    ;;
esac

# eksctl rejects root ARNs ("arn is neither user nor role") because
# aws-auth ConfigMap entries are user/role only. Root doesn't need an
# explicit mapping anyway — EKS implicitly grants system:masters to the
# cluster-creator IAM principal, and root is the creator of every
# cluster in its account. Skip the mapping step and warn the operator.
case "$MAPPING_ARN" in
  arn:aws:iam::*:root)
    info "running as root — skipping aws-auth mapping (root has implicit cluster-admin)"
    info "  WARNING: running deploys with root credentials is not recommended;"
    info "  create a dedicated IAM user/role and re-run this script with those creds."
    ;;
  *)
    info "ensuring $MAPPING_ARN is mapped to system:masters in aws-auth"
    # `eksctl create iamidentitymapping` is *not* idempotent by default — it
    # appends a second record to aws-auth on every run. The `--no-duplicate-
    # arns` flag inverts that to a hard error on dupes (still not what we
    # want). Check first, then create only if missing.
    if silent eksctl get iamidentitymapping \
         --cluster "$CLUSTER_NAME" \
         --region "$AWS_REGION" \
         --arn "$MAPPING_ARN"; then
      info "  $MAPPING_ARN already mapped — skipping"
    else
      silent eksctl create iamidentitymapping \
        --cluster "$CLUSTER_NAME" \
        --region "$AWS_REGION" \
        --arn "$MAPPING_ARN" \
        --group system:masters \
        --username "litellm-agents-deployer"
    fi
    ;;
esac

# ---- 5. Exec-plugin kubeconfig ------------------------------------------
# The kubernetes-client-node library invokes `aws-iam-authenticator token`
# on every API call (matching the `exec` block below) and uses the
# resulting bearer token to dial the apiserver. The AWS credentials in
# the deploy env (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) are read
# from the inherited process env by the authenticator binary, so the
# kubeconfig itself carries no secret and never expires.
APISERVER=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" \
              --query 'cluster.endpoint' --output text)
CA_DATA=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" \
              --query 'cluster.certificateAuthority.data' --output text)

KUBECONFIG_BODY=$(cat <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${APISERVER}
    certificate-authority-data: ${CA_DATA}
  name: ${CLUSTER_NAME}
contexts:
- context:
    cluster: ${CLUSTER_NAME}
    user: aws-iam
    namespace: default
  name: ${CLUSTER_NAME}
current-context: ${CLUSTER_NAME}
users:
- name: aws-iam
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws-iam-authenticator
      args:
      - token
      - -i
      - ${CLUSTER_NAME}
      env:
      - name: AWS_REGION
        value: ${AWS_REGION}
      interactiveMode: Never
      provideClusterInfo: false
EOF
)

# ---- 6. Output -----------------------------------------------------------
# Capture the current first-node ExternalIP for the operator's reference,
# but tell them to set `K8S_NODE_HOST=auto` so the platform discovers
# Ready node IPs via the apiserver at request time. Pinning a single IP
# breaks every nodegroup scale or node replacement (see
# src/server/k8s.ts resolveNodeHost).
SAMPLE_HOST=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalIP")].address}' 2>/dev/null)
if [ -z "$SAMPLE_HOST" ]; then
  SAMPLE_HOST=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalDNS")].address}' 2>/dev/null)
fi

info ""
info "=== READY ==="
info "Set K8S_NODE_HOST=auto on web/worker. Platform discovers a Ready"
info "node ExternalIP via the apiserver at spawn time and caches for 30s."
info "Pinning a single IP breaks on nodegroup scale (sample IP: $SAMPLE_HOST)."
info ""
info "The kubeconfig below uses aws-iam-authenticator at runtime, so the"
info "deploy env must also set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /"
info "AWS_REGION. The kubeconfig itself never expires."
info ""
info "Paste the base64 string below into KUBE_CONFIG_B64 on Render / Railway:"
info ""

# Only base64 hits stdout — easy to capture with `bin/eks-up.sh > kube.b64`.
printf '%s' "$KUBECONFIG_BODY" | base64 | tr -d '\n'
echo
