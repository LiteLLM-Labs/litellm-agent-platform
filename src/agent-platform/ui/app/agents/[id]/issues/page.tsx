"use client";

/**
 * /agents/:id/issues — all issues reported by this agent across sessions.
 *
 * The agent calls `report_issue` via MCP; this page surfaces those reports
 * so operators can triage without hunting through individual session threads.
 */

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle, CircleOff, Loader2, RefreshCw } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/ui/table";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/ui/select";
import {
  AgentRow,
  ApiError,
  IssueRow,
  getAgent,
  listIssues,
  updateIssue,
} from "@/ui/lib/api";

interface PageProps {
  params: Promise<{ id: string }>;
}

function formatRelative(iso: string): string {
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

const SEVERITY_COLORS: Record<string, string> = {
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  warning: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  error: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  critical: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
};

const STATUS_COLORS: Record<string, string> = {
  open: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  resolved: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  dismissed: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export default function IssuesPage({ params }: PageProps) {
  const router = useRouter();
  const { id } = use(params);

  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [updating, setUpdating] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [a, rows] = await Promise.all([
        getAgent(id),
        listIssues(id, { status: statusFilter === "all" ? undefined : statusFilter }),
      ]);
      setAgent(a);
      setIssues(rows);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, [id, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  async function handleUpdateStatus(issueId: string, status: string) {
    setUpdating(issueId);
    try {
      const updated = await updateIssue(id, issueId, { status });
      setIssues((prev) =>
        prev ? prev.map((i) => (i.id === issueId ? updated : i)) : prev,
      );
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUpdating(null);
    }
  }

  const openCount = issues ? issues.filter((i) => i.status === "open").length : null;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <button
        onClick={() => router.push(`/agents/${id}`)}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to agent
      </button>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Issues{agent?.name ? ` · ${agent.name}` : ""}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Problems reported by the agent via{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">report_issue</code>{" "}
            across all sessions.
            {openCount !== null && openCount > 0 && (
              <span className="ml-2 font-medium text-orange-600 dark:text-orange-400">
                {openCount} open
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
            <SelectTrigger className="w-32 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="icon" className="size-8" onClick={load}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </header>

      {err && (
        <div className="mb-4 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {err}
        </div>
      )}

      {issues === null && !err && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      )}

      {issues !== null && issues.length === 0 && (
        <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">
          No {statusFilter !== "all" ? statusFilter : ""} issues.
        </div>
      )}

      {issues !== null && issues.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead className="w-24">Severity</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-36">Session</TableHead>
                <TableHead className="w-28">Reported</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issues.map((issue) => (
                <TableRow
                  key={issue.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/agents/${id}/issues/${issue.id}`)}
                >
                  <TableCell>
                    <div className="font-medium text-sm">
                      {issue.title}
                      {(issue as any).times_seen > 1 && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          ×{(issue as any).times_seen}
                        </span>
                      )}
                    </div>
                    {issue.body && (
                      <div className="mt-1 text-xs text-muted-foreground line-clamp-2 max-w-md">
                        {issue.body}
                      </div>
                    )}
                    {(issue as any).comments?.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          {(issue as any).comments.length} occurrence{(issue as any).comments.length !== 1 ? 's' : ''}
                        </summary>
                        <div className="mt-1 space-y-1 pl-2 border-l border-border">
                          {(issue as any).comments.map((c: any) => (
                            <div key={c.id} className="text-xs text-muted-foreground">
                              <span className="font-mono">{c.session_id?.slice(0, 8) ?? '—'}</span>
                              {' · '}{formatRelative(c.created_at)}
                              {c.body && <div className="mt-0.5 text-xs">{c.body}</div>}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_COLORS[issue.severity] ?? ""}`}
                    >
                      {issue.severity}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[issue.status] ?? ""}`}
                    >
                      {issue.status}
                    </span>
                  </TableCell>
                  <TableCell>
                    {issue.session_id ? (
                      <button
                        onClick={() => router.push(`/sessions/${issue.session_id}`)}
                        className="font-mono text-xs text-muted-foreground hover:text-foreground truncate max-w-[9rem] block"
                        title={issue.session_id}
                      >
                        {issue.session_id.slice(0, 8)}…
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(issue.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    {issue.status === "open" && (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          title="Mark resolved"
                          disabled={updating === issue.id}
                          onClick={() => handleUpdateStatus(issue.id, "resolved")}
                        >
                          {updating === issue.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <CheckCircle className="size-3.5 text-green-600" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          title="Dismiss"
                          disabled={updating === issue.id}
                          onClick={() => handleUpdateStatus(issue.id, "dismissed")}
                        >
                          <CircleOff className="size-3.5 text-muted-foreground" />
                        </Button>
                      </div>
                    )}
                    {issue.status !== "open" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={updating === issue.id}
                        onClick={() => handleUpdateStatus(issue.id, "open")}
                      >
                        Reopen
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
