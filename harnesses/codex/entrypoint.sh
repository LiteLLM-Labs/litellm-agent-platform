#!/usr/bin/env bash
# Codex (OpenAI) TUI harness entrypoint.
# All common setup (vault, git clone, LAP_FILE injection, phase reporting) is
# handled by the shared script. See harnesses/_shared/entrypoint-common.sh.
set -euo pipefail

. /opt/lap/common.sh

# Hydrate attached skills as ~/.claude/skills/<slug>/SKILL.md when present.
# Codex doesn't read this directory natively today, but we materialize the
# files anyway so the user can `cat` / reference them inside the TUI, and so
# any future skill consumer here picks them up. Empty/unset = no-op.
if [ -n "${SKILLS_JSON:-}" ]; then
  mkdir -p "$HOME/.claude/skills"
  printf '%s' "$SKILLS_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const skills = JSON.parse(raw);
        const fs = require("fs"), path = require("path");
        const root = path.join(process.env.HOME, ".claude", "skills");
        // Whitelist slugs to kebab-case ASCII so a crafted "../" entry
        // cant escape the skills dir via path.join. Mirrors the slug shape
        // produced by slugifySkillName() on the platform side.
        const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
        for (const { slug, content } of skills) {
          if (!slug || typeof content !== "string") continue;
          if (!SLUG_RE.test(slug)) {
            console.error("[entrypoint] WARNING: skipping skill with invalid slug:", JSON.stringify(slug));
            continue;
          }
          const dir = path.join(root, slug);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "SKILL.md"), content);
        }
        console.log("[entrypoint] hydrated " + skills.length + " skill(s)");
      } catch (e) {
        console.error("[entrypoint] WARNING: SKILLS_JSON parse failed:", e.message);
      }
    });
  ' || echo "[entrypoint] WARNING: skill hydration failed; continuing"
fi

exec node /app/server.js
