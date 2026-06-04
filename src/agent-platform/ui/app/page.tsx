"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, FileText, Paperclip, X } from "lucide-react";

import { AgentRow, ApiError, SkillRow, listAgents, listSkills, spawnSession } from "@/ui/lib/api";
import { cn } from "@/ui/lib/utils";

function agentLabel(a: AgentRow): string {
  return a.name?.trim() || a.id.slice(0, 8);
}

const EXAMPLE_PROMPTS = [
  { label: "Fix a bug", prompt: "Find and fix the bug causing " },
  { label: "Write tests", prompt: "Write tests for " },
  { label: "Review PR", prompt: "Review this pull request and suggest improvements: " },
  { label: "Refactor", prompt: "Refactor this code to be cleaner and more maintainable: " },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function LandingPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentRow | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const comboRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Skill slash-command state
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [activeSkill, setActiveSkill] = useState<SkillRow | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listAgents()
      .then((rows) => {
        setAgents(rows);
        if (rows.length > 0) {
          setSelectedAgent(rows[0]);
          setQuery(agentLabel(rows[0]));
        }
      })
      .catch(() => {});
    listSkills().then(setSkills).catch(() => {});
  }, []);

  // close agent combo on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setOpen(false);
        if (selectedAgent) setQuery(agentLabel(selectedAgent));
      }
      // close skill dropdown on outside click
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        textareaRef.current !== e.target
      ) {
        setSlashOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [selectedAgent]);

  const filtered = agents.filter((a) =>
    agentLabel(a).toLowerCase().includes(query.toLowerCase()),
  );

  const filteredSkills = skills.filter((s) =>
    s.name.toLowerCase().includes(slashFilter.toLowerCase()) ||
    (s.description ?? "").toLowerCase().includes(slashFilter.toLowerCase()),
  );

  function select(a: AgentRow) {
    setSelectedAgent(a);
    setQuery(agentLabel(a));
    setOpen(false);
  }

  function selectSkill(skill: SkillRow) {
    setActiveSkill(skill);
    setText("/" + skill.name + " ");
    setSlashOpen(false);
    setSlashFilter("");
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function clearSkill() {
    setActiveSkill(null);
    const t = text.startsWith("/" + (activeSkill?.name ?? "") + " ")
      ? text.slice((activeSkill?.name.length ?? 0) + 2)
      : text.replace(/^\/[^\s]*\s*/, "");
    setText(t);
    textareaRef.current?.focus();
  }

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setText(val);

    if (!val.startsWith("/")) {
      setSlashOpen(false);
      setSlashFilter("");
      if (activeSkill) setActiveSkill(null);
      return;
    }

    const afterSlash = val.slice(1);
    const firstSpace = afterSlash.indexOf(" ");

    if (firstSpace === -1) {
      // Still composing the skill name — show dropdown
      setSlashFilter(afterSlash);
      setSlashOpen(true);
      setSlashIndex(0);
      if (activeSkill && afterSlash !== activeSkill.name) {
        setActiveSkill(null);
      }
    } else {
      // Space found — skill name portion is locked
      const typedName = afterSlash.slice(0, firstSpace);
      setSlashOpen(false);
      if (!activeSkill || activeSkill.name !== typedName) {
        const matched = skills.find(
          (s) => s.name.toLowerCase() === typedName.toLowerCase(),
        );
        setActiveSkill(matched ?? null);
      }
    }
  }

  const effectivePrompt = text.trim();
  const canSubmit = !spawning && !!selectedAgent && !!effectivePrompt;

  async function handleSubmit() {
    if (!canSubmit || !selectedAgent) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setSpawning(true);
    setError(null);
    try {
      const session = await spawnSession(
        selectedAgent.id,
        {
          title: effectivePrompt.slice(0, 80),
          initial_prompt: effectivePrompt,
          ...(activeSkill ? { skill_ids: [activeSkill.id] } : {}),
        },
        { signal: abortRef.current.signal },
      );
      router.push(`/sessions/${session.id}`);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setSpawning(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Skill dropdown navigation
    if (slashOpen && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, filteredSkills.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (filteredSkills[slashIndex]) selectSkill(filteredSkills[slashIndex]);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (filteredSkills[0]) selectSkill(filteredSkills[slashIndex] ?? filteredSkills[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  return (
    <div
      className="flex min-h-full flex-col items-center justify-center gap-4 px-12 pb-24"
      style={{
        backgroundImage:
          "radial-gradient(circle, rgba(148,163,184,0.28) 1px, transparent 1px)",
        backgroundSize: "20px 20px",
      }}
    >
      {/* Greeting */}
      <div className="flex items-center gap-3 mb-2">
        <span className="text-2xl">🚄</span>
        <h1 className="text-[28px] font-semibold tracking-tight text-foreground">
          {greeting()}
        </h1>
      </div>

      {/* Composer wrapper — relative so skill dropdown can anchor above */}
      <div className="relative w-full max-w-[640px]">

        {/* Skill slash-command dropdown */}
        {slashOpen && (
          <div
            ref={dropdownRef}
            className="absolute top-full left-0 right-0 mt-2 z-50 rounded-xl border border-border bg-background shadow-lg overflow-hidden"
          >
            {filteredSkills.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-muted-foreground">
                No skills match &ldquo;{slashFilter}&rdquo;
              </p>
            ) : (
              <>
                <div className="px-3 pt-2.5 pb-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    Skills
                  </span>
                </div>
                {filteredSkills.slice(0, 8).map((sk, i) => (
                  <button
                    key={sk.id}
                    type="button"
                    onMouseDown={() => selectSkill(sk)}
                    onMouseEnter={() => setSlashIndex(i)}
                    className={cn(
                      "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors",
                      i === slashIndex ? "bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <div className={cn(
                      "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
                      i === slashIndex
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-border bg-muted/50 text-muted-foreground",
                    )}>
                      <FileText className="size-3" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {sk.name}
                      </span>
                      {sk.description && (
                        <span className="block truncate text-[11px] text-muted-foreground mt-0.5">
                          {sk.description}
                        </span>
                      )}
                    </div>
                    {i === slashIndex && (
                      <span className="shrink-0 self-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        ↵
                      </span>
                    )}
                  </button>
                ))}
                <div className="border-t border-border px-3 py-2 flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground/50">↑↓ navigate</span>
                  <span className="text-[10px] text-muted-foreground/50">↵ select</span>
                  <span className="text-[10px] text-muted-foreground/50">esc dismiss</span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Composer card */}
        <div className="w-full rounded-xl border border-border bg-background shadow-lg ring-1 ring-border">
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            rows={4}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            disabled={spawning}
            placeholder={activeSkill ? `Ask ${activeSkill.name} anything…` : "Ask or build anything — type / to use a skill"}
            className="block w-full resize-none rounded-t-xl border-none bg-transparent px-4 pt-4 pb-2 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-50"
          />

          {/* Active skill badge + agent row */}
          <div className="flex items-center gap-1.5 px-3 pb-2">

            {/* Active skill badge */}
            {activeSkill && (
              <div className="flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 dark:border-blue-800 dark:bg-blue-950">
                <FileText className="size-3 text-blue-600 dark:text-blue-400" />
                <span className="text-[11px] font-medium text-blue-700 dark:text-blue-300">
                  {activeSkill.name}
                </span>
                <button
                  type="button"
                  onClick={clearSkill}
                  className="ml-0.5 text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-200"
                  aria-label="Remove skill"
                >
                  <X className="size-2.5" />
                </button>
              </div>
            )}

            {/* Searchable agent combobox */}
            <div ref={comboRef} className="relative">
              <div className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted transition-colors">
                <svg
                  width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className="shrink-0 text-muted-foreground"
                >
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                </svg>
                <input
                  type="text"
                  value={query}
                  disabled={spawning}
                  onChange={(e) => { setQuery(e.target.value); setOpen(true); setSelectedAgent(null); }}
                  onFocus={() => { setOpen(true); setQuery(""); }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { setOpen(false); if (selectedAgent) setQuery(agentLabel(selectedAgent)); }
                    if (e.key === "Enter" && filtered.length > 0) { select(filtered[0]); }
                  }}
                  placeholder="Select agent…"
                  className={cn(
                    "w-36 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-40",
                    selectedAgent && "font-medium",
                  )}
                />
              </div>

              {open && (filtered.length > 0 || query) && (
                <div className="absolute left-0 top-full z-50 mt-1 max-h-56 w-64 overflow-y-auto rounded-md border border-border bg-background shadow-md">
                  {filtered.length === 0 ? (
                    <p className="px-3 py-2 text-[12px] text-muted-foreground">No agents match &ldquo;{query}&rdquo;</p>
                  ) : filtered.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onMouseDown={() => select(a)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-muted",
                        selectedAgent?.id === a.id && "font-medium text-foreground",
                      )}
                    >
                      <span className="flex-1 truncate">{agentLabel(a)}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">
                        {a.id.slice(0, 6)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1" />

            <button
              type="button"
              disabled={spawning}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              aria-label="Attach file"
            >
              <Paperclip className="size-3.5" />
            </button>

            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
              aria-label="Send"
            >
              <ArrowUp className="size-3.5" />
            </button>
          </div>

          {/* Model strip */}
          <div className="flex items-center rounded-b-xl border-t border-border bg-muted px-3 py-1.5">
            <span className="font-mono text-[11px] text-muted-foreground">
              {selectedAgent?.model ?? "—"}
            </span>
            <div className="flex-1" />
            {skills.length > 0 && !activeSkill && (
              <span className="text-[11px] text-muted-foreground/40">
                type <kbd className="rounded border border-border bg-background px-1 font-mono text-[10px]">/</kbd> for skills
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Example prompt chips */}
      <div className="flex flex-wrap justify-center gap-2 max-w-[640px]">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setText(p.prompt);
              textareaRef.current?.focus();
            }}
            className="flex items-center gap-1.5 rounded-full border border-border bg-background/80 px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="max-w-[640px] rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </p>
      )}

      {spawning && (
        <p className="text-[12px] text-muted-foreground">Starting session…</p>
      )}

    </div>
  );
}
