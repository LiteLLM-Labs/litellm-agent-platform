"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Copy,
  FileJson,
  GitPullRequest,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { HarnessIdentity, getHarnessOption } from "@/ui/components/harness-picker";
import { Input } from "@/ui/components/ui/input";
import { Label } from "@/ui/components/ui/label";
import { Textarea } from "@/ui/components/ui/textarea";
import { AgentTemplate, listTemplates } from "@/ui/lib/api";
import { cn } from "@/ui/lib/utils";

const INTERNAL_TEMPLATES_STORAGE = "lap_internal_agent_templates";

interface TemplateSpec {
  id: string;
  name: string;
  description: string;
  harness: string;
  model: string;
  system: string;
  mcp_servers: string[];
  tools: Array<{ type: string }>;
  skills: string[];
  source: "global" | "internal";
}

const BLANK_TEMPLATE: TemplateSpec = {
  id: "blank-agent-config",
  name: "Blank agent config",
  description: "A blank starting point with the core toolset.",
  harness: "codex",
  model: "claude-sonnet-4-6",
  system:
    "You are a general-purpose agent that can research, write code, run commands, and use connected tools to complete the user's task end to end.",
  mcp_servers: [],
  tools: [{ type: "agent_toolset_20260401" }],
  skills: [],
  source: "internal",
};

const FALLBACK_TEMPLATES: TemplateSpec[] = [
  BLANK_TEMPLATE,
  {
    id: "coding-agent",
    name: "Coding Agent",
    description: "General-purpose coding agent with memory and PR workflow.",
    harness: "claude-agent-sdk",
    model: "anthropic/claude-sonnet-4-6",
    system: "You are a coding agent. You can write code, debug issues, and prepare PRs.",
    mcp_servers: [],
    tools: [{ type: "agent_toolset_20260401" }],
    skills: ["coding-agent"],
    source: "global",
  },
  {
    id: "security-pr-scan",
    name: "Security PR Scanner",
    description: "Scans pull requests for secrets, OWASP issues, dependency risk, and auth regressions.",
    harness: "claude-agent-sdk",
    model: "anthropic/claude-sonnet-4-6",
    system: "You are a security agent. Scan pull requests and report vulnerabilities by severity.",
    mcp_servers: [],
    tools: [{ type: "agent_toolset_20260401" }],
    skills: ["reviewing-security"],
    source: "global",
  },
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toCsv(value: string[]): string {
  return value.join(", ");
}

function toTemplate(template: AgentTemplate): TemplateSpec {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    harness: template.harness_id,
    model: template.model,
    system: template.prompt,
    mcp_servers: [],
    tools:
      template.tools.length > 0
        ? template.tools.map((tool) => ({ type: tool }))
        : [{ type: "agent_toolset_20260401" }],
    skills: template.skill_name ? [template.skill_name] : [],
    source: "global",
  };
}

function loadInternalTemplates(): TemplateSpec[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(INTERNAL_TEMPLATES_STORAGE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((template) => ({ ...BLANK_TEMPLATE, ...template, source: "internal" }))
      : [];
  } catch {
    return [];
  }
}

function saveInternalTemplates(templates: TemplateSpec[]): void {
  window.localStorage.setItem(INTERNAL_TEMPLATES_STORAGE, JSON.stringify(templates));
}

function toJson(spec: TemplateSpec): string {
  return JSON.stringify(
    {
      name: spec.name,
      description: spec.description,
      harness: spec.harness,
      model: spec.model,
      system: spec.system,
      mcp_servers: spec.mcp_servers,
      tools: spec.tools,
      skills: spec.skills,
    },
    null,
    2,
  );
}

function yamlValue(value: string): string {
  if (!value.includes("\n")) return JSON.stringify(value);
  return `|\n${value.split("\n").map((line) => `  ${line}`).join("\n")}`;
}

function toYaml(spec: TemplateSpec): string {
  return [
    `name: ${yamlValue(spec.name)}`,
    `description: ${yamlValue(spec.description)}`,
    `harness: ${yamlValue(spec.harness)}`,
    `model: ${yamlValue(spec.model)}`,
    `system: ${yamlValue(spec.system)}`,
    "mcp_servers:",
    ...(spec.mcp_servers.length ? spec.mcp_servers.map((item) => `  - ${yamlValue(item)}`) : ["  []"]),
    "tools:",
    ...spec.tools.map((tool) => `  - type: ${yamlValue(tool.type)}`),
    "skills:",
    ...(spec.skills.length ? spec.skills.map((item) => `  - ${yamlValue(item)}`) : ["  []"]),
  ].join("\n");
}

type DrawerMode = "create" | "edit" | null;

export default function AgentTemplatesPage() {
  const router = useRouter();
  const [globalTemplates, setGlobalTemplates] = useState<TemplateSpec[]>([]);
  const [internalTemplates, setInternalTemplates] = useState<TemplateSpec[]>([]);
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(null);
  const [editing, setEditing] = useState<TemplateSpec>(BLANK_TEMPLATE);
  const [mcpServers, setMcpServers] = useState("");
  const [skills, setSkills] = useState("");
  const [toolType, setToolType] = useState("agent_toolset_20260401");
  const [format, setFormat] = useState<"json" | "yaml">("json");
  const [showSpec, setShowSpec] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const internal = loadInternalTemplates();
    setInternalTemplates(internal);
    listTemplates()
      .then((templates) => {
        const loaded = templates.map(toTemplate);
        setGlobalTemplates(loaded.length > 0 ? loaded : FALLBACK_TEMPLATES.filter((t) => t.source === "global"));
      })
      .catch(() => setGlobalTemplates(FALLBACK_TEMPLATES.filter((t) => t.source === "global")));
  }, []);

  const templates = useMemo(
    () => [BLANK_TEMPLATE, ...internalTemplates, ...globalTemplates],
    [globalTemplates, internalTemplates],
  );
  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((template) => [
      template.name,
      template.description,
      template.harness,
      template.model,
      template.source,
    ].some((value) => value.toLowerCase().includes(q)));
  }, [search, templates]);
  const preview = format === "json" ? toJson(editing) : toYaml(editing);
  const thClass = "px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground select-none";

  function openCreate() {
    setEditing({ ...BLANK_TEMPLATE, id: "new-agent-template", name: "New agent template" });
    setMcpServers("");
    setSkills("");
    setToolType("agent_toolset_20260401");
    setShowSpec(false);
    setDrawerMode("create");
    setNotice(null);
  }

  function openEdit(template: TemplateSpec) {
    setEditing({
      ...template,
      id: template.source === "global" ? `${template.id}-copy` : template.id,
      source: "internal",
    });
    setMcpServers(toCsv(template.mcp_servers));
    setSkills(toCsv(template.skills));
    setToolType(template.tools[0]?.type ?? "agent_toolset_20260401");
    setShowSpec(false);
    setDrawerMode("edit");
    setNotice(template.source === "global" ? "Editing a global template saves an internal copy." : null);
  }

  function closeDrawer() {
    setDrawerMode(null);
    setShowSpec(false);
  }

  function updateEditing(next: Partial<TemplateSpec>) {
    setEditing((current) => {
      const name = next.name ?? current.name;
      const id =
        next.name && current.id === slugify(current.name)
          ? slugify(name) || current.id
          : current.id;
      return { ...current, ...next, id };
    });
    setNotice(null);
  }

  function handleMcpChange(e: ChangeEvent<HTMLInputElement>) {
    setMcpServers(e.target.value);
    updateEditing({ mcp_servers: parseCsv(e.target.value) });
  }

  function handleSkillsChange(e: ChangeEvent<HTMLInputElement>) {
    setSkills(e.target.value);
    updateEditing({ skills: parseCsv(e.target.value) });
  }

  function handleToolChange(e: ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setToolType(value);
    updateEditing({ tools: [{ type: value || "agent_toolset_20260401" }] });
  }

  function saveInternal() {
    const normalized: TemplateSpec = {
      ...editing,
      id: editing.id || slugify(editing.name) || `template-${Date.now()}`,
      mcp_servers: parseCsv(mcpServers),
      skills: parseCsv(skills),
      tools: [{ type: toolType.trim() || "agent_toolset_20260401" }],
      source: "internal",
    };
    const next = [
      normalized,
      ...internalTemplates.filter((template) => template.id !== normalized.id),
    ];
    setInternalTemplates(next);
    saveInternalTemplates(next);
    setEditing(normalized);
    setDrawerMode("edit");
    setNotice("Saved internally.");
  }

  function deleteTemplate(template: TemplateSpec) {
    if (template.source !== "internal") return;
    const next = internalTemplates.filter((item) => item.id !== template.id);
    setInternalTemplates(next);
    saveInternalTemplates(next);
    if (editing.id === template.id) closeDrawer();
    setNotice("Deleted internal template.");
  }

  function publishGlobally(template: TemplateSpec) {
    setEditing(template);
    setMcpServers(toCsv(template.mcp_servers));
    setSkills(toCsv(template.skills));
    setToolType(template.tools[0]?.type ?? "agent_toolset_20260401");
    setDrawerMode("edit");
    setShowSpec(true);
    setNotice("Publish globally prepares a PR to add this template to LAP's shared JSON catalog.");
  }

  function copyPreview() {
    navigator.clipboard.writeText(preview).catch(() => {});
    setNotice(`${format.toUpperCase()} copied.`);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[18px] font-semibold tracking-tight">Agent Templates</h1>
          <span className="text-[13px] text-muted-foreground tabular-nums">{templates.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => router.push("/agents")}>
            <ArrowLeft className="size-4" /> Agents
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" /> Add template
          </Button>
        </div>
      </header>

      <div className="flex items-center gap-2 border-b bg-muted/20 px-6 py-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search templates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
          />
        </div>
        {notice ? (
          <p className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{notice}</p>
        ) : null}
      </div>

      <main className="min-h-0 flex-1 overflow-auto">
        {filteredTemplates.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <p className="text-sm text-muted-foreground">No templates match your search.</p>
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className={thClass} style={{ paddingLeft: "calc(1.5rem + 28px + 12px)" }}>
                  Template
                </th>
                <th className={thClass}>Harness</th>
                <th className={thClass}>Model</th>
                <th className={thClass}>Source</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {filteredTemplates.map((template) => {
                const harnessOption = getHarnessOption(template.harness);
                return (
                  <tr
                    key={`${template.source}-${template.id}`}
                    onClick={() => openEdit(template)}
                    className="cursor-pointer border-b transition-colors hover:bg-muted/40"
                  >
                    <td className="px-6 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="grid size-7 shrink-0 place-items-center rounded-lg border bg-background/70">
                          <FileJson className="size-3.5 text-muted-foreground" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-foreground">{template.name}</div>
                          <div className="truncate text-[10px] text-muted-foreground/70">{template.description}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <HarnessIdentity
                        option={harnessOption}
                        harnessId={template.harness}
                        model={template.model}
                        size="compact"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-[11px] text-muted-foreground">{template.model}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="rounded-md font-mono text-[10px]">
                        {template.source}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(template)} aria-label={`Edit ${template.name}`}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => publishGlobally(template)} aria-label={`Publish ${template.name}`}>
                          <GitPullRequest className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => deleteTemplate(template)}
                          disabled={template.source !== "internal"}
                          aria-label={`Delete ${template.name}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </main>

      {drawerMode ? (
        <aside className="fixed bottom-0 right-0 top-0 z-30 flex w-[min(760px,calc(100vw-240px))] min-w-[340px] flex-col border-l bg-background shadow-2xl">
          <div className="flex h-14 items-center justify-between border-b px-5">
            <div className="min-w-0">
              <div className="truncate text-[15px] font-medium">
                {drawerMode === "create" ? "Add template" : editing.name}
              </div>
              <div className="text-[12px] text-muted-foreground">
                {showSpec ? "JSON/YAML preview" : "Internal template editor"}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowSpec((open) => !open)}>
                <FileJson className="size-4" /> {showSpec ? "Form" : "Spec"}
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={closeDrawer} aria-label="Close editor">
                <X className="size-4" />
              </Button>
            </div>
          </div>

          {showSpec ? (
            <>
              <div className="flex items-center justify-between border-b px-5 py-2">
                <div className="inline-flex rounded-lg border bg-muted/20 p-0.5">
                  {(["json", "yaml"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setFormat(value)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[12px] font-medium uppercase",
                        format === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                      )}
                    >
                      {value}
                    </button>
                  ))}
                </div>
                <Button variant="ghost" size="icon-sm" onClick={copyPreview} aria-label="Copy template spec">
                  <Copy className="size-4" />
                </Button>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto bg-background px-8 py-6 font-mono text-[13px] leading-6 text-foreground">
                {preview}
              </pre>
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="template-name">Name</Label>
                    <Input
                      id="template-name"
                      value={editing.name}
                      onChange={(e) => updateEditing({ name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="template-model">Model</Label>
                    <Input
                      id="template-model"
                      value={editing.model}
                      onChange={(e) => updateEditing({ model: e.target.value })}
                      className="font-mono"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="template-description">Description</Label>
                  <Input
                    id="template-description"
                    value={editing.description}
                    onChange={(e) => updateEditing({ description: e.target.value })}
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="template-harness">Harness</Label>
                    <select
                      id="template-harness"
                      value={editing.harness}
                      onChange={(e) => updateEditing({ harness: e.target.value })}
                      className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="codex">codex</option>
                      <option value="claude-agent-sdk">claude-agent-sdk</option>
                      <option value="opencode">opencode</option>
                      <option value="brain-inline">brain-inline</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="template-tool">Toolset</Label>
                    <Input
                      id="template-tool"
                      value={toolType}
                      onChange={handleToolChange}
                      className="font-mono"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="template-system">System</Label>
                  <Textarea
                    id="template-system"
                    value={editing.system}
                    onChange={(e) => updateEditing({ system: e.target.value })}
                    className="min-h-[180px] font-mono text-[12px]"
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="template-mcp">MCP servers</Label>
                    <Input
                      id="template-mcp"
                      value={mcpServers}
                      onChange={handleMcpChange}
                      placeholder="github, slack"
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="template-skills">Skills</Label>
                    <Input
                      id="template-skills"
                      value={skills}
                      onChange={handleSkillsChange}
                      placeholder="review, docs"
                      className="font-mono"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="border-t px-5 py-3">
            <div className="mb-2 rounded-lg border bg-muted/25 px-3 py-2 text-[12px] text-muted-foreground">
              <strong className="font-medium text-foreground">Save internally</strong> stores this in the workspace.{" "}
              <strong className="font-medium text-foreground">Publish globally</strong> prepares a PR for the shared JSON catalog.
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => publishGlobally(editing)}>
                <GitPullRequest className="size-4" /> Publish globally
              </Button>
              <Button onClick={saveInternal}>Save internally</Button>
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
