# Runtime Templates

Each `templates/<name>/` is a self-contained server that exposes an AI agent
runtime behind the **Anthropic Managed Agents API spec**, so any LAP SDK client
can drive it by changing only `api_base`/`api_key`. Existing examples:
`deepagents/`, `hermes/`, `opencode/`.

## Creating a new runtime template

**Use the [`create-harness`](../skills/create-harness.md) skill.** It walks the
full scaffold — interview, runtime research, server + event-translation layer,
Dockerfile, README, and tests — and keeps the new template consistent with the
ones already here. Do not hand-roll a template from scratch; start from the
skill.

## Registration

Every template must be listed in [`manifest.json`](./manifest.json) — the
source of truth for which templates LAP can install. The `create-harness` skill
adds this entry as part of scaffolding (see its `manifest.json` step); a
template missing from the manifest is invisible to LAP.
