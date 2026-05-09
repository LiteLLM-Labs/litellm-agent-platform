#!/usr/bin/env bash
set -euo pipefail

# Replace key=value in .env in-place; append if missing. `|` is the sed
# delimiter — values from prompts can contain `/` and `:`.
update_env() {
  local key="$1" val="$2" file=".env"
  if [ ! -f "$file" ]; then
    echo "$key=$val" >> "$file"
    return
  fi
  if grep -q "^${key}=" "$file"; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$file" && rm -f "${file}.bak"
  else
    echo "$key=$val" >> "$file"
  fi
}

# Bootstrap .env from .env.example with a random MASTER_KEY on first run.
if [ ! -f .env ]; then
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    update_env MASTER_KEY "$(openssl rand -hex 32)"
  fi
  echo "✓ created .env from .env.example with a random MASTER_KEY"
  echo
fi

# Prompt for any required key that's still blank. Non-interactive shells
# (CI etc.) get the legacy behavior — print what's missing and exit.
prompt_missing() {
  local key="$1" label="$2" default="$3" secret="$4"
  local current
  current=$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/')
  if [ -n "$current" ]; then return; fi

  if [ ! -t 0 ]; then
    echo "✗ ${key} is empty in .env. Fill it in and re-run." >&2
    exit 1
  fi

  local val
  if [ -n "$default" ]; then
    read -r -p "${label} [${default}]: " val
    val="${val:-$default}"
  elif [ "$secret" = "1" ]; then
    read -r -s -p "${label}: " val; echo
  else
    read -r -p "${label}: " val
  fi
  if [ -z "$val" ]; then
    echo "✗ ${key} is required."; exit 1
  fi
  update_env "$key" "$val"
}

prompt_missing AWS_REGION             "AWS region"               "us-east-1" 0
prompt_missing LITELLM_API_BASE       "LiteLLM gateway URL"      ""          0
prompt_missing LITELLM_API_KEY        "LiteLLM API key"          ""          1

set -a
source .env
set +a

# AWS credentials — accept whatever the default provider chain finds.
# Env vars in .env work, AWS_PROFILE + ~/.aws/credentials works, SSO works,
# instance roles work. We just confirm the chain resolves before continuing.
if ! aws sts get-caller-identity --region "$AWS_REGION" >/dev/null 2>&1; then
  cat >&2 <<EOF
✗ AWS credentials not found.

Pick one:
  • paste keys into .env (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
  • set AWS_PROFILE=<name> in .env (uses ~/.aws/credentials or SSO)
  • run \`aws sso login --profile <name>\` first
  • attach an IAM role if you're on EC2/ECS

Then re-run: ./setup.sh
EOF
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
TAG=$(git rev-parse --short HEAD)
ROLE=litellm-agents-task-exec
LOG_GROUP=/ecs/litellm-agents
SG=litellm-agents-sg

# 1. IAM exec role (idempotent) — shared across both task def families
aws iam get-role --role-name "$ROLE" 2>/dev/null || aws iam create-role \
  --role-name "$ROLE" --assume-role-policy-document file://setup/trust-policy.json
aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# 2. Log group (shared)
aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --region "$AWS_REGION" \
  | grep -q "$LOG_GROUP" || aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$AWS_REGION"

# 3. ECS cluster (shared)
aws ecs describe-clusters --clusters "$AWS_CLUSTER" --region "$AWS_REGION" \
  --query "clusters[?status=='ACTIVE']" --output text | grep -q . \
  || aws ecs create-cluster --cluster-name "$AWS_CLUSTER" --region "$AWS_REGION"

# 4. Default VPC + public subnet + SG (shared)
VPC_ID=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query "Vpcs[0].VpcId" --region "$AWS_REGION" --output text)
SUBNET_ID=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID Name=map-public-ip-on-launch,Values=true \
  --query "Subnets[0].SubnetId" --region "$AWS_REGION" --output text)
SG_ID=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG Name=vpc-id,Values=$VPC_ID \
  --query "SecurityGroups[0].GroupId" --region "$AWS_REGION" --output text 2>/dev/null || echo "")
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  SG_ID=$(aws ec2 create-security-group --group-name "$SG" --vpc-id "$VPC_ID" \
    --description "litellm managed agents" --region "$AWS_REGION" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 4096 --cidr 0.0.0.0/0 --region "$AWS_REGION"
fi

# 5. ECR login (shared) — once for the registry, both repos sit under it.
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# 6. Build / push / register each harness. New harness = one extra row here
# plus a matching env var on the platform.
#   field 1: harness id (also the family + repo + dir name)
#   field 2: env var to populate with the resulting task def ARN
HARNESSES=(
  "opencode|AWS_TASK_DEFINITION_ARN_OPENCODE"
  "claude-agent-sdk|AWS_TASK_DEFINITION_ARN_CLAUDE_SDK"
)

build_and_register() {
  local harness="$1" env_key="$2"
  local repo="litellm-agents-${harness}"
  local family="litellm-agents-${harness}"
  local image_uri="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$repo:$TAG"

  echo
  echo "=== ${harness} ==="

  aws ecr describe-repositories --repository-names "$repo" --region "$AWS_REGION" 2>/dev/null \
    || aws ecr create-repository --repository-name "$repo" --region "$AWS_REGION" >/dev/null

  docker build --platform linux/amd64 \
    -f "harnesses/${harness}/Dockerfile" \
    -t "$image_uri" \
    "harnesses/${harness}"
  docker push "$image_uri"

  local arn
  arn=$(aws ecs register-task-definition --region "$AWS_REGION" \
    --family "$family" --network-mode awsvpc --requires-compatibilities FARGATE \
    --cpu 512 --memory 1024 \
    --execution-role-arn "arn:aws:iam::$ACCOUNT_ID:role/$ROLE" \
    --runtime-platform '{"cpuArchitecture":"X86_64","operatingSystemFamily":"LINUX"}' \
    --container-definitions "$(cat <<JSON
[{"name":"harness","image":"$image_uri","essential":true,
  "portMappings":[{"containerPort":4096,"protocol":"tcp"}],
  "logConfiguration":{"logDriver":"awslogs","options":{
    "awslogs-group":"$LOG_GROUP","awslogs-region":"$AWS_REGION","awslogs-stream-prefix":"harness"}}}]
JSON
)" --query "taskDefinition.taskDefinitionArn" --output text)

  update_env "$env_key" "$arn"
  echo "  ✓ ${env_key}=${arn}"
}

for entry in "${HARNESSES[@]}"; do
  build_and_register "${entry%%|*}" "${entry##*|}"
done

# 7. Legacy single-arn alias. The platform falls back to AWS_TASK_DEFINITION_ARN
# when a per-harness override is missing — point it at opencode so existing
# rows that were created before per-harness routing landed keep working.
LEGACY_ARN=$(grep -E '^AWS_TASK_DEFINITION_ARN_OPENCODE=' .env | head -1 | cut -d= -f2-)
update_env AWS_TASK_DEFINITION_ARN "$LEGACY_ARN"

# 8. Networking values (shared across harnesses).
update_env AWS_SUBNETS        "$SUBNET_ID"
update_env AWS_SECURITY_GROUP "$SG_ID"

cat <<EOF

✓ wrote into .env:
  AWS_TASK_DEFINITION_ARN=<opencode (legacy alias)>
  AWS_TASK_DEFINITION_ARN_OPENCODE=<set>
  AWS_TASK_DEFINITION_ARN_CLAUDE_SDK=<set>
  AWS_SUBNETS=$SUBNET_ID
  AWS_SECURITY_GROUP=$SG_ID
EOF
