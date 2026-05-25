# E2B sandbox template

The agent sandboxes (E2B `provision`/`execute` tools) run on an E2B template.
This is its source so it lives in version control instead of only on someone's
laptop.

`E2B_TEMPLATE` (see `src/server/env.ts`) selects which template the platform
uses when it spins up a sandbox.

## What's in it
- Base: `e2bdev/code-interpreter` (Python + Node + Jupyter).
- **Pre-cloned repos** (no per-session clone):
  - `https://github.com/BerriAI/litellm` → `/home/user/litellm`
  - `https://github.com/BerriAI/litellm-docs` → `/home/user/litellm-docs`
- **All `litellm[proxy]` deps pre-installed** — no per-session install wait.
- **Global pip.conf** always points at `https://pypi.org/simple` with the combined CA cert — no `--trusted-host` / `--index-url` flags ever needed.
- **`uv` pre-installed** via pip (not the curl/astral installer) so `uv_build` resolves cleanly.
- **PostgreSQL cluster** owned by `user` at `/home/user/pgdata`, dev db `litellm` pre-created — **auto-started on sandbox boot** (`start_cmd` in `e2b.toml`).
- **`DATABASE_URL` (and proxy creds) baked in as image `ENV`** — available to every command, no setup step. E2B runs each command in a fresh shell, so `source dev-up` exports wouldn't carry across commands; image `ENV` does.
- **`/usr/local/bin/dev-up`**: convenience for an interactive shell (starts postgres + echoes env).

Both repos are public, so no token is baked into the image.

## Standing up the proxy (from inside a sandbox)

Postgres is already running and `DATABASE_URL` is already set — just boot the proxy:

```bash
cd ~/litellm && python -m litellm.proxy.proxy_cli --port 4000 --detailed_debug
```

In an interactive shell you can `source /usr/local/bin/dev-up` to print the env
and ensure postgres is up, but it's not required.

Dev credentials baked into the image as `ENV` (and echoed by `dev-up`):

| Var | Value |
|-----|-------|
| `DATABASE_URL` | `postgresql://litellm:litellm@localhost:5432/litellm` |
| `LITELLM_MASTER_KEY` | `sk-1234` |
| `LITELLM_SALT_KEY` | `sk-litellm-salt-dev-unsafe` |
| `STORE_MODEL_IN_DB` | `True` |

## Build / update
Requires E2B CLI auth (`e2b auth login`) for the team that owns the template.

```bash
cd e2b
e2b template build --name litellm-4gb --cpu-count 8 --memory-mb 4096
```

`--cpu-count 8 --memory-mb 4096` matches the 4 GB spec. After it builds, set
`E2B_TEMPLATE` (and `E2B_API_KEY` for the owning team) on the platform service.

To refresh the pinned repo contents, rebuild with `--no-cache`.
```
