"use client";

/**
 * /agents/:id/memory — manage the agent's durable memory.
 *
 * Backed by /api/v1/managed_agents/agents/:id/memory (GET grep / POST add /
 * PATCH disable+priority+text / DELETE). The agent itself can save memory
 * via the save_memory tool inside the harness, and shin pipes Slack
 * `remember:` messages here too — this page is for human curation.
 */

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AgentRow,
  ApiError,
  MemoryRow,
  createMemory,
  deleteMemory,
  getAgent,
  listMemory,
  updateMemory,
} from "@/lib/api";

interface PageProps {
  params: Promise<{ id: string }>;
}

type SortKey = "priority" | "most_used" | "recently_used" | "newest";

function formatRelative(iso?: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export default function MemoryPage({ params }: PageProps) {
  const router = useRouter();
  const { id } = use(params);

  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("__all__");
  const [sortKey, setSortKey] = useState<SortKey>("priority");

  const [draftText, setDraftText] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [draftType, setDraftType] = useState("convention");
  const [draftPriority, setDraftPriority] = useState(0);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [a, m] = await Promise.all([getAgent(id), listMemory(id)]);
      setAgent(a);
      setRows(m);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) for (const t of r.tags) s.add(t);
    return [...s].sort();
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = rows.filter(
      (r) =>
        (q === "" || r.text.toLowerCase().includes(q)) &&
        (tagFilter === "__all__" || r.tags.includes(tagFilter)),
    );
    out = [...out].sort((a, b) => sortCompare(a, b, sortKey));
    return out;
  }, [rows, search, tagFilter, sortKey]);

  const counts = useMemo(() => {
    let active = 0;
    let disabled = 0;
    for (const r of rows) (r.disabled ? disabled++ : active++);
    return { active, disabled };
  }, [rows]);

  async function handleAdd() {
    const text = draftText.trim();
    if (text.length === 0) return;
    setAdding(true);
    try {
      const tags = draftTags
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const created = await createMemory(id, {
        text,
        tags,
        type: draftType,
        priority: draftPriority,
      });
      setRows((prev) => [created, ...prev]);
      setDraftText("");
      setDraftTags("");
      setDraftPriority(0);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setErr(msg);
    } finally {
      setAdding(false);
    }
  }

  async function applyUpdate(
    memory_id: string,
    patch: Parameters<typeof updateMemory>[2],
  ) {
    try {
      const updated = await updateMemory(id, memory_id, patch);
      setRows((prev) =>
        prev.map((r) => (r.id === memory_id ? updated : r)),
      );
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setErr(msg);
    }
  }

  async function handleDelete(memory_id: string) {
    if (!confirm("Delete this memory? This cannot be undone.")) return;
    try {
      await deleteMemory(id, memory_id);
      setRows((prev) => prev.filter((r) => r.id !== memory_id));
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setErr(msg);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <button
        onClick={() => router.push(`/agents/${id}`)}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to agent
      </button>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Memory{agent?.name ? ` · ${agent.name}` : ""}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {counts.active} active, {counts.disabled} disabled. Top entries are
          pre-loaded into every new session's system prompt; the agent also
          searches this list before finalizing a PR.
        </p>
      </header>

      {err && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {err}
        </div>
      )}

      <section className="mb-6 rounded-lg border bg-card/40 p-4">
        <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
          Add memory
        </h2>
        <Textarea
          placeholder="One rule, phrased generically. e.g. For UI changes always use shadcn Tag, never @tremor/react Badge."
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          rows={2}
          className="mb-2"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="tags (comma-separated, e.g. ui,antd)"
            value={draftTags}
            onChange={(e) => setDraftTags(e.target.value)}
            className="max-w-xs"
          />
          <Select
            value={draftType}
            onValueChange={(v) => v && setDraftType(v)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="convention">convention</SelectItem>
              <SelectItem value="constraint">constraint</SelectItem>
              <SelectItem value="reference">reference</SelectItem>
              <SelectItem value="preference">preference</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={String(draftPriority)}
            onValueChange={(v) => setDraftPriority(Number(v))}
          >
            <SelectTrigger className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">priority 0</SelectItem>
              <SelectItem value="1">priority 1</SelectItem>
              <SelectItem value="2">priority 2</SelectItem>
              <SelectItem value="3">priority 3</SelectItem>
            </SelectContent>
          </Select>
          <Button
            onClick={() => void handleAdd()}
            disabled={adding || draftText.trim().length === 0}
          >
            {adding ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add
          </Button>
        </div>
      </section>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search memory…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select
          value={tagFilter}
          onValueChange={(v) => v && setTagFilter(v)}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All tags" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All tags</SelectItem>
            {allTags.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sortKey}
          onValueChange={(v) => setSortKey(v as SortKey)}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="priority">Priority</SelectItem>
            <SelectItem value="most_used">Most used</SelectItem>
            <SelectItem value="recently_used">Recently used</SelectItem>
            <SelectItem value="newest">Newest</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto size-5 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          {rows.length === 0
            ? "No memory yet. Teach the agent by adding above or letting it save lessons during a session."
            : "No matches."}
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((m) => (
            <li
              key={m.id}
              className={`rounded-lg border bg-card/40 p-3 ${
                m.disabled ? "opacity-50" : ""
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="w-12 shrink-0 pt-0.5 text-sm font-medium text-primary">
                  ★ {m.priority}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm ${m.disabled ? "line-through" : ""}`}
                  >
                    {m.text}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <Badge variant="outline" className="text-[10px]">
                      {m.type}
                    </Badge>
                    {m.tags.map((t) => (
                      <Badge key={t} variant="secondary" className="text-[10px]">
                        {t}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[11px] text-muted-foreground">
                    applied {m.times_applied}× · last used{" "}
                    {formatRelative(m.last_applied_at)} · source: {m.source}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void applyUpdate(m.id, { priority: m.priority + 1 })
                    }
                    title="Increase priority"
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void applyUpdate(m.id, {
                        priority: Math.max(0, m.priority - 1),
                      })
                    }
                    title="Decrease priority"
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void applyUpdate(m.id, { disabled: !m.disabled })
                    }
                    title={m.disabled ? "Re-enable" : "Disable"}
                  >
                    {m.disabled ? "↻" : "⊘"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleDelete(m.id)}
                    title="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sortCompare(a: MemoryRow, b: MemoryRow, key: SortKey): number {
  switch (key) {
    case "priority":
      return (
        b.priority - a.priority ||
        b.times_applied - a.times_applied ||
        b.created_at.localeCompare(a.created_at)
      );
    case "most_used":
      return (
        b.times_applied - a.times_applied || b.priority - a.priority
      );
    case "recently_used": {
      const at = a.last_applied_at ?? "";
      const bt = b.last_applied_at ?? "";
      return bt.localeCompare(at);
    }
    case "newest":
      return b.created_at.localeCompare(a.created_at);
  }
}
