/**
 * Agent template loader.
 *
 * Scans agent-templates/*\/template.json at startup and assembles each
 * template from its directory:
 *
 *   agent-templates/
 *     <id>/
 *       template.json   required — id, name, description, icon, tags,
 *                                  harness_id, model, skill_name, tools
 *       prompt.md       required — system prompt text
 *       skill.md        required — bundled skill shown/editable in the UI
 *       Dockerfile      optional — per-template image (not read here,
 *                                  used by CI to build + push)
 *
 * Adding a new template = new directory. No TypeScript changes needed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  harness_id: string;
  model: string;
  prompt: string;
  skill_name: string;
  skill: string;
  tools: string[];
}

interface TemplateManifest {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  harness_id: string;
  model: string;
  skill_name: string;
  tools: string[];
}

const TEMPLATES_DIR = join(process.cwd(), "agent-templates");

function loadTemplates(): AgentTemplate[] {
  let dirs: string[];
  try {
    dirs = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // Directory absent (e.g. during next build phase) — return empty.
    return [];
  }

  const out: AgentTemplate[] = [];
  for (const dir of dirs) {
    const base = join(TEMPLATES_DIR, dir);
    try {
      const manifest: TemplateManifest = JSON.parse(
        readFileSync(join(base, "template.json"), "utf8"),
      );
      const prompt = readFileSync(join(base, "prompt.md"), "utf8").trim();
      // Strip YAML frontmatter (---...---) before embedding into context —
      // the frontmatter is for the Skills spec UI, not for the agent's prompt.
      const rawSkill = readFileSync(join(base, "skill.md"), "utf8").trim();
      const skill = rawSkill.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
      out.push({ ...manifest, prompt, skill });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[templates] skipping ${dir}: ${msg}`);
    }
  }
  return out;
}

// Load once at startup — templates are static files, no hot-reload needed.
const TEMPLATES: AgentTemplate[] = loadTemplates();

export function listTemplates(): AgentTemplate[] {
  return TEMPLATES;
}

export function getTemplate(id: string): AgentTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
