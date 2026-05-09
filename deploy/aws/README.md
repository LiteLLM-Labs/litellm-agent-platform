# AWS

Sandbox cluster on EKS. Web + worker can sit anywhere — Render, Railway,
ECS Fargate, App Runner, or another EKS cluster — they just need the
kubeconfig produced below.

## One script

```bash
AWS_ACCESS_KEY_ID=AKIA... \
AWS_SECRET_ACCESS_KEY=... \
AWS_REGION=us-east-1 \
  bin/eks-up.sh > kube-config.b64
```

Takes ~15 min. Creates an EKS cluster, opens NodePort 30000-30099 on the
node security group, installs the agent-sandbox controller, mints a
long-lived service-account kubeconfig, prints it as base64, and reports
a `K8S_NODE_HOST` you can paste into Render / Railway env.

Re-runnable. If the cluster already exists, it's reused.

Optional knobs:

| Env             | Default            |
|-----------------|--------------------|
| `CLUSTER_NAME`  | `litellm-agents`   |
| `NODE_TYPE`     | `t3.medium`        |
| `NODE_COUNT`    | `1`                |
| `K8S_VERSION`   | `1.30`             |
| `AGENT_SANDBOX_VERSION` | `v0.4.5`   |

Tear down:

```bash
eksctl delete cluster --name litellm-agents --region "$AWS_REGION"
```

## After the script

Paste into Render / Railway / your platform of choice:

| Var                  | Value                                                  |
|----------------------|--------------------------------------------------------|
| `KUBE_CONFIG_B64`    | `cat kube-config.b64`                                  |
| `K8S_NODE_HOST`      | (printed by the script)                                |
| `K8S_HARNESS_IMAGE`  | ECR path of `opencode-sandbox:<tag>`                   |

## Push the harness image to ECR

```bash
ECR="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$AWS_REGION.amazonaws.com"
aws ecr create-repository --repository-name opencode-sandbox || true
aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR"
docker tag opencode-sandbox:dev "$ECR/opencode-sandbox:latest"
docker push "$ECR/opencode-sandbox:latest"
```

`K8S_HARNESS_IMAGE=$ECR/opencode-sandbox:latest`.

## Gotchas

- **NodePort range exposure.** `bin/eks-up.sh` opens the security group
  to `0.0.0.0/0` for ports 30000-30099. Tighten to your platform's egress
  CIDR if you have one.
- **Static token.** The minted token is valid for 10 years. Rotate by
  re-running the script (it's idempotent on the SA + binding).
- **Cluster IAM.** The script uses your default AWS profile credentials.
  Use a dedicated IAM user with `eksctl`-required permissions in CI.
- **Cost.** A `t3.medium` single-node cluster + NAT gateway runs ~$45/mo.
  Bump `NODE_COUNT` for warm-pool capacity past ~5 sandboxes.
