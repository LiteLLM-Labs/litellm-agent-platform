"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Bot,
  Loader2,
  Pencil,
  Plus,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import Link from "next/link";
import { Button } from "@/ui/components/ui/button";
import { Label } from "@/ui/components/ui/label";
import { Textarea } from "@/ui/components/ui/textarea";
import { AgentFormFields, DEFAULT_HARNESS_ID } from "@/ui/components/agent-form-fields";
import { EnabledTools } from "@/ui/components/mcp-tools-picker";
import {
  PROJECT_REQUIRED_HARNESS_IDS,
} from "@/ui/lib/constants";
import {
  AgentTemplate,
  ApiError,
  McpAllowedTools,
  ProjectConfig,
  createAgent,
  createSkill,
  getPreinstalledGithubRepo,
  listProjects,
  listTemplates,
} from "@/ui/lib/api";
import { cn } from "@/ui/lib/utils";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const NAME_MAX = 64;

function normalizeRepoUrl(repo: string | undefined): string | undefined {
  const trimmed = repo?.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}`;
  }
  return trimmed;
}

interface LocalProject {
  id: string;
  name: string;
  description?: string;
  repo_url?: string;
  env_vars?: Record<string, string>;
  allow_out?: string[];
  deny_out?: string[];
}

export default function NewAgentPage() {
  const router = useRouter();

  // "blank" = no template; any other string = template id
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("blank");
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [activeTemplateTab, setActiveTemplateTab] = useState<"overview" | "files" | "skill" | "prompt">("overview");
  // Per-template skill edits — keyed by template id
  const [skillEdits, setSkillEdits] = useState<Record<string, string>>({});
  // Per-template skill edit mode — false = rendered preview, true = raw textarea
  const [skillEditMode, setSkillEditMode] = useState<Record<string, boolean>>({});

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;
  const currentSkill = selectedTemplate
    ? (skillEdits[selectedTemplate.id] ?? selectedTemplate.skill)
    : "";

  useEffect(() => {
    listTemplates().then(setTemplates).catch(() => {});
  }, []);

  // Projects (repo + env var keys) from localStorage
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  // Multi-select for brain-inline harness
  const [selectedProjects, setSelectedProjects] = useState<LocalProject[]>([]);

  useEffect(() => {
    listProjects()
      .then((res) => setProjects(res.data.map((p) => ({
        id: p.project_id,
        name: p.name,
        description: p.description ?? undefined,
        repo_url: p.repo_url ?? undefined,
        env_vars: p.env_vars,
        allow_out: p.allow_out,
        deny_out: p.deny_out,
        files: p.files,
      })))
      )
      .catch(() => { /* ignore */ });
  }, []);

  function applyProject(id: string | null) {
    setSelectedProjectId(id === selectedProjectId ? null : id);
  }

  function selectTemplate(id: string) {
    setSelectedTemplateId(id);
    setActiveTemplateTab("overview");
    const t = templates.find((t) => t.id === id);
    if (t) {
      setName(t.name);
      setHarnessId(t.harness_id);
      setModel(t.model);
      const parts = [t.prompt, t.skill ? `<!-- skill -->\n\n${skillEdits[t.id] ?? t.skill}` : ""].filter(Boolean);
      setSystemPrompt(parts.join("\n\n"));
      const templateVars = Object.entries(t.env_vars).filter(([k]) => !k.startsWith("LAP_FILE_"));
      setEnvVars(templateVars.length > 0 ? templateVars : [["", ""]]);
    } else {
      // blank
      setName("");
      setHarnessId(DEFAULT_HARNESS_ID);
      setModel(DEFAULT_MODEL);
      setSystemPrompt("");
      setEnvVars([["", ""]]);
    }
  }

  // Form state — controlled props for AgentFormFields
  const [name, setName] = useState("");
  const [harnessId, setHarnessId] = useState<string>(DEFAULT_HARNESS_ID);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [branchOverride, setBranchOverride] = useState("");
  const [pfpUrl, setPfpUrl] = useState<string | null>(null);
  const [envVars, setEnvVars] = useState<[string, string][]>([["", ""]]);
  const [envVarHosts, setEnvVarHosts] = useState<Record<string, string[]>>({});
  const [enabledTools, setEnabledTools] = useState<EnabledTools>(new Map());
  const [mcpToolTotals, setMcpToolTotals] = useState<Map<string, number>>(new Map());

  // Skill state
  const [pickedSkillIds, setPickedSkillIds] = useState<string[]>([]);
  const [skillName, setSkillName] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [skillMode, setSkillMode] = useState<null | "write" | "pick">(null);
  const [skillSaveToLibrary, setSkillSaveToLibrary] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preinstalledRepo, setPreinstalledRepo] = useState<string>("");
  const [, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPreinstalledGithubRepo()
      .catch(() => "")
      .then((repo) => { if (!cancelled) setPreinstalledRepo(repo); })
      .catch((e) => { if (!cancelled) setMetaError(e instanceof ApiError ? e.message : (e as Error).message); })
      .finally(() => { if (!cancelled) setLoadingMeta(false); });
    return () => { cancelled = true; };
  }, []);

  function validate(): string | null {
    const trimmedName = name.trim();
    if (trimmedName.length > NAME_MAX) {
      return `Name must be ${NAME_MAX} characters or fewer.`;
    }
    if (!model.trim()) return "Model is required.";
    if (PROJECT_REQUIRED_HARNESS_IDS.has(harnessId) && selectedProjects.length === 0) {
      return "Select at least one sandbox project for this harness.";
    }
    return null;
  }

  const projectRequired = PROJECT_REQUIRED_HARNESS_IDS.has(harnessId);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    // Every secret must declare at least one allowed host — that's the whole
    // point of the per-secret scoping.
    const unscoped = envVars
      .map(([k]) => k.trim())
      .filter((k) => k && !(envVarHosts[k]?.length));
    if (unscoped.length > 0) {
      setError(`Set at least one allowed host for: ${unscoped.join(", ")}`);
      return;
    }

    setSubmitting(true);
    try {
      const mcpServers: string[] = [];
      const mcpAllowedTools: McpAllowedTools[] = [];
      for (const [serverId, toolSet] of enabledTools.entries()) {
        if (toolSet.size === 0) continue;
        mcpServers.push(serverId);
        const total = mcpToolTotals.get(serverId);
        if (total === undefined || toolSet.size < total) {
          mcpAllowedTools.push({
            server_id: serverId,
            tools: Array.from(toolSet).sort(),
          });
        }
      }

      const envVarsRecord: Record<string, string> = {};
      for (const [k, v] of envVars) {
        const key = k.trim();
        if (key) envVarsRecord[key] = v;
      }
      // Keep only host lists for credentials that still exist on submit, and
      // derive the agent's egress allowlist from the union of all per-secret
      // hosts — there's no separate global list.
      const finalEnvVarHosts: Record<string, string[]> = {};
      for (const key of Object.keys(envVarsRecord)) {
        if (envVarHosts[key]?.length) finalEnvVarHosts[key] = envVarHosts[key];
      }
      // Egress = per-secret hosts ∪ the project template's non-secret hosts, so
      // a template's allow_out (e.g. a public endpoint the agent browses without
      // auth) isn't dropped just because it isn't tied to a credential.
      const projAllowOut =
        projects.find((s) => s.id === selectedProjectId)?.allow_out ?? [];
      const derivedAllowOut = [
        ...new Set([...projAllowOut, ...Object.values(finalEnvVarHosts).flat()]),
      ];

      // If a template is selected and the user edited the skill panel, merge back.
      let finalPrompt = systemPrompt.trim() || undefined;
      if (selectedTemplate) {
        const editedSkill = skillEdits[selectedTemplate.id];
        if (editedSkill !== undefined) {
          const SEPARATOR = "<!-- skill -->";
          const separatorIdx = systemPrompt.indexOf(SEPARATOR);
          const basePrompt =
            separatorIdx >= 0
              ? systemPrompt.slice(0, separatorIdx).trimEnd()
              : systemPrompt.trimEnd();
          finalPrompt =
            `${basePrompt}\n\n${SEPARATOR}\n\n${editedSkill}`.trim() || undefined;
        }
      }

      // Append newly-picked library skills
      for (const skillId of pickedSkillIds) {
        finalPrompt = (finalPrompt ?? "") + `\n<!-- skill:${skillId} -->\n`;
      }

      // Merge inline skill into prompt
      if (skillInstructions.trim()) {
        const base = (finalPrompt ?? "").trimEnd();
        finalPrompt = base
          ? `${base}\n<!-- skill -->\n${skillInstructions.trim()}`
          : skillInstructions.trim();
        if (skillSaveToLibrary && skillName.trim()) {
          createSkill({
            name: skillName.trim(),
            description: skillDesc.trim() || undefined,
            content: skillInstructions.trim(),
          }).catch(() => {});
        }
      }

      const selectedProject = projects.find((s) => s.id === selectedProjectId);
      const repoUrl = normalizeRepoUrl(
        selectedProject?.repo_url || preinstalledRepo || undefined,
      );
      const created = await createAgent({
        name: name.trim() || undefined,
        model: model.trim(),
        prompt: finalPrompt,
        harness_id: harnessId,
        requirements: selectedTemplate?.requirements ?? undefined,
        repo_url: repoUrl,
        branch: branchOverride.trim() || undefined,
        pfp_url: pfpUrl ?? undefined,
        mcp_servers: mcpServers.length > 0 ? mcpServers : undefined,
        mcp_allowed_tools: mcpAllowedTools.length > 0 ? mcpAllowedTools : undefined,
        env_vars: Object.keys(envVarsRecord).length > 0 ? envVarsRecord : undefined,
        env_var_hosts: Object.keys(finalEnvVarHosts).length > 0 ? finalEnvVarHosts : undefined,
        allow_out: derivedAllowOut,
        deny_out: selectedProject?.deny_out,
        skill_ids: pickedSkillIds.length > 0 ? pickedSkillIds : undefined,
        // Preserve template provenance so the platform can detect version drift
        // and surface "sync available" when the template is later updated.
        template_id: selectedTemplate?.id ?? undefined,
        projects: PROJECT_REQUIRED_HARNESS_IDS.has(harnessId) && selectedProjects.length > 0
          ? selectedProjects.map((p): ProjectConfig => ({
              id: p.id,
              name: p.name,
              description: p.description ?? "",
              repo_url: p.repo_url,
              branch: "main",
            }))
          : undefined,
      });
      router.push(`/agents/${created.id}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-full bg-background">
      <div className="w-full px-5 py-6 lg:px-8">
        <header className="mb-5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Back to agents"
              onClick={() => router.push("/agents")}
              className="text-muted-foreground"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-[20px] font-semibold tracking-tight">Create agent</h1>
              <p className="text-[12px] text-muted-foreground">Choose a template, runtime, and tools.</p>
            </div>
          </div>
          <Button type="submit" form="new-agent-form" disabled={submitting} size="sm">
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {submitting ? "Creating" : "Create"}
          </Button>
        </header>

        <form
          id="new-agent-form"
          className="space-y-5"
          onSubmit={onSubmit}
          noValidate
        >
          <section className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              Template
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-5">
            <button
              type="button"
              onClick={() => selectTemplate("blank")}
              className={cn(
                "min-h-[92px] rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent/30",
                selectedTemplateId === "blank"
                  ? "border-foreground/60 bg-accent/30"
                  : "border-dashed border-border bg-background/50",
              )}
            >
              <span className="flex items-center gap-2">
                <Bot className="size-3.5 text-muted-foreground" />
                <span className="text-[13px] font-medium">Blank</span>
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">Start from scratch.</span>
            </button>

            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => selectTemplate(t.id)}
                className={cn(
                  "min-h-[92px] rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent/30",
                  selectedTemplateId === t.id
                    ? "border-foreground/60 bg-accent/30"
                    : "border-border bg-background/50",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="text-[13px]" aria-hidden>{t.icon}</span>
                  <span className="truncate text-[13px] font-medium">{t.name}</span>
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                  {t.description}
                </span>
              </button>
            ))}
            </div>
          </section>

              {/* Project picker — new-only */}
              {projects.length > 0 && (
                <section className="space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">Project</p>
                  <p className="text-[11px] text-muted-foreground">
                    Pre-fills repo URL and env var keys. Values stay empty.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {projects.map((t) => {
                      const active = selectedProjectId === t.id;
                      const keys = Object.keys(t.env_vars ?? {});
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => applyProject(active ? null : t.id)}
                          disabled={submitting}
                          className={cn(
                            "flex min-w-[160px] flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                            active
                              ? "border-foreground/70 bg-accent/40"
                              : "border-border bg-background/60 hover:bg-accent/30",
                          )}
                        >
                          <span className="text-[13px] font-medium text-foreground">{t.name}</span>
                          {t.repo_url && (
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {t.repo_url.replace("https://github.com/", "")}
                            </span>
                          )}
                          {keys.length > 0 && (
                            <span className="font-mono text-[9px] text-muted-foreground">
                              {keys.length} env var{keys.length !== 1 ? "s" : ""}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {(() => {
                    const sel = projects.find((s) => s.id === selectedProjectId);
                    const keys = Object.keys(sel?.env_vars ?? {});
                    if (!sel || keys.length === 0) return null;
                    return (
                      <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5">
                        <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Env vars in this template
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {keys.map((k) => (
                            <span key={k} className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                              {k}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </section>
              )}

            <section className="rounded-lg border bg-card/70 p-5 shadow-sm lg:p-6">
              <AgentFormFields
                name={name} onNameChange={setName}
                pfpUrl={pfpUrl} onPfpUrlChange={setPfpUrl}
                harnessId={harnessId} onHarnessIdChange={setHarnessId}
                model={model} onModelChange={setModel}
                branchOverride={branchOverride} onBranchOverrideChange={setBranchOverride}
                systemPrompt={systemPrompt} onSystemPromptChange={setSystemPrompt}
                pickedSkillIds={pickedSkillIds} onPickedSkillIdsChange={setPickedSkillIds}
                skillName={skillName} onSkillNameChange={setSkillName}
                skillDesc={skillDesc} onSkillDescChange={setSkillDesc}
                skillInstructions={skillInstructions} onSkillInstructionsChange={setSkillInstructions}
                skillMode={skillMode} onSkillModeChange={setSkillMode}
                skillSaveToLibrary={skillSaveToLibrary} onSkillSaveToLibraryChange={setSkillSaveToLibrary}
                envVars={envVars} onEnvVarsChange={setEnvVars}
                envVarHosts={envVarHosts} onEnvVarHostsChange={setEnvVarHosts}
                enabledTools={enabledTools}
                onEnabledToolsChange={(v) => setEnabledTools(v as Parameters<typeof setEnabledTools>[0])}
                onMcpToolTotals={setMcpToolTotals}
                disabled={submitting}
              />
            </section>

              {/* Sandbox projects — inline brain harnesses only */}
              {projectRequired && (
                <section className="rounded-lg border bg-card/70 p-5 shadow-sm lg:p-6">
                  <Label>Sandbox projects</Label>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    Inline brain harnesses need at least one sandbox project.
                  </p>
                  {projects.length > 0 ? (
                    <div className="mt-3 divide-y rounded-lg border bg-background/50">
                      {projects.map((p) => (
                        <label key={p.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-accent/30">
                          <input
                            type="checkbox"
                            checked={selectedProjects.some((sp) => sp.id === p.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedProjects([...selectedProjects, p]);
                              } else {
                                setSelectedProjects(selectedProjects.filter((sp) => sp.id !== p.id));
                              }
                            }}
                            className="rounded"
                          />
                          <span className="flex flex-col">
                            <span className="text-[13px] font-medium">{p.name}</span>
                            {p.repo_url && (
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {p.repo_url.replace("https://github.com/", "")}
                              </span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[12px] text-muted-foreground">
                      No projects found.{" "}
                      <Link href="/projects/new" className="underline underline-offset-2 hover:text-foreground">
                        Create a project
                      </Link>{" "}
                      to add sandbox templates.
                    </p>
                  )}
                </section>
              )}

              {metaError ? (
                <p className="font-mono text-xs text-muted-foreground">
                  Could not load repo info: {metaError}
                </p>
              ) : null}

              {error ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-2 border-t pt-4">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={submitting}
                  onClick={() => router.push("/agents")}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  {submitting ? "Creating" : "Create agent"}
                </Button>
              </div>
          </form>

        {selectedTemplate && (
          <section className="mt-4 overflow-hidden rounded-lg border bg-card/70 shadow-sm">
              <div className="flex border-b text-[13px]">
                {(["overview", "files", "skill", "prompt"] as const)
                  .filter((tab) => {
                    if (tab === "files") return selectedTemplate.files.length > 0;
                    if (tab === "skill") return !!selectedTemplate.skill;
                    if (tab === "prompt") return !!selectedTemplate.prompt;
                    return true;
                  })
                  .map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTemplateTab(tab)}
                      className={cn(
                        "px-4 py-2 font-medium capitalize transition-colors hover:text-foreground",
                        activeTemplateTab === tab
                          ? "border-b-2 border-foreground text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {tab}
                    </button>
                  ))}
              </div>
              <div className="p-4">
                {activeTemplateTab === "overview" && (
                  <div className="space-y-3 text-[13px]">
                    {selectedTemplate.files.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Files</p>
                        <div className="space-y-1">
                          {selectedTemplate.files.map((f) => (
                            <div key={f.template_path} className="flex items-center gap-2 font-mono text-[12px]">
                              <span className="rounded border border-border bg-muted px-2 py-0.5">{f.template_path}</span>
                              <span className="text-muted-foreground">→</span>
                              <span className="text-muted-foreground">{f.sandbox_path}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedTemplate.tools.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Tools</p>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedTemplate.tools.map((tool) => (
                            <span key={tool} className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[12px]">
                              {tool}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedTemplate.skill_name && (
                      <div>
                        <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Skill</p>
                        <div className="flex items-center gap-2">
                          <span className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[12px]">
                            {selectedTemplate.skill_name}
                          </span>
                          <button
                            type="button"
                            aria-label="View skill details"
                            onClick={() => setActiveTemplateTab("skill")}
                            className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            View →
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {activeTemplateTab === "files" && (
                  <div className="space-y-4">
                    {selectedTemplate.files.map((f) => (
                      <div key={f.template_path}>
                        <div className="mb-1.5 flex items-center gap-2 font-mono text-[12px]">
                          <span className="rounded border border-border bg-muted px-2 py-0.5">{f.template_path}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="text-muted-foreground">{f.sandbox_path}</span>
                        </div>
                        <pre className="overflow-x-auto rounded-md border bg-muted/30 px-4 py-3 font-mono text-[12px] text-foreground">{f.content}</pre>
                      </div>
                    ))}
                  </div>
                )}
                {activeTemplateTab === "skill" && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[13px] font-semibold">{selectedTemplate.skill_name}</p>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            setSkillEditMode((prev) => ({
                              ...prev,
                              [selectedTemplate.id]: !prev[selectedTemplate.id],
                            }))
                          }
                          className="flex items-center gap-1 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                          {skillEditMode[selectedTemplate.id] ? "Preview" : "Edit"}
                        </button>
                        {skillEdits[selectedTemplate.id] !== undefined && (
                          <button
                            type="button"
                            onClick={() =>
                              setSkillEdits((prev) => {
                                const next = { ...prev };
                                delete next[selectedTemplate.id];
                                return next;
                              })
                            }
                            className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </div>
                    {skillEditMode[selectedTemplate.id] ? (
                      <Textarea
                        value={currentSkill}
                        onChange={(e) =>
                          setSkillEdits((prev) => ({
                            ...prev,
                            [selectedTemplate.id]: e.target.value,
                          }))
                        }
                        className="min-h-[400px] font-mono text-[12px]"
                        spellCheck={false}
                      />
                    ) : (
                      <div className="prose prose-sm dark:prose-invert max-w-none overflow-y-auto rounded-md border bg-muted/30 px-4 py-3 text-[13px] [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {currentSkill}
                        </ReactMarkdown>
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Edits are local to this agent — template is unchanged.
                    </p>
                  </div>
                )}
                {activeTemplateTab === "prompt" && (
                  <Textarea
                    aria-label="System prompt preview"
                    value={selectedTemplate.prompt}
                    readOnly
                    className="min-h-[400px] text-[13px] opacity-70"
                  />
                )}
              </div>
          </section>
        )}
      </div>
    </div>
  );
}
