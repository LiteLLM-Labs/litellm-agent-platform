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

After scaffolding, register the template in [`manifest.json`](./manifest.json)
with an entry: `id`, `name`, `description`, `path`, `default_alias`, and
`api_spec` (currently always `claude_managed_agents`). The manifest is the
source of truth for which templates LAP can install.
