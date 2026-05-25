"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle, CircleOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ApiError, IssueRow, getIssue, updateIssue } from "@/lib/api";

interface PageProps {
  params: Promise<{ id: string; issue_id: string }>;
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function formatRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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

export default function IssueDetailPage({ params }: PageProps) {
  const router = useRouter();
  const { id, issue_id } = use(params);

  const [issue, setIssue] = useState<IssueRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try { setIssue(await getIssue(id, issue_id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  }, [id, issue_id]);

  useEffect(() => { void load(); }, [load]);

  async function handleStatus(status: string) {
    setUpdating(true);
    try {
      setIssue(await updateIssue(id, issue_id, { status }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  }

  const comments = (issue as any)?.comments ?? [];

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <button
        onClick={() => router.push(`/agents/${id}/issues`)}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to issues
      </button>

      {err && (
        <div className="mb-4 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{err}</div>
      )}

      {!issue && !err && (
        <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      )}

      {issue && (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">{issue.title}</h1>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_COLORS[issue.severity] ?? ""}`}>
                  {issue.severity}
                </span>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[issue.status] ?? ""}`}>
                  {issue.status}
                </span>
                {(issue as any).times_seen > 1 && (
                  <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    ×{(issue as any).times_seen} occurrences
                  </span>
                )}
                <span className="text-xs text-muted-foreground">{formatTime(issue.created_at)}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {issue.status === "open" && (
                <>
                  <Button size="sm" variant="outline" disabled={updating} onClick={() => handleStatus("resolved")}>
                    {updating ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle className="size-3.5 text-green-600" />}
                    Resolve
                  </Button>
                  <Button size="sm" variant="ghost" disabled={updating} onClick={() => handleStatus("dismissed")}>
                    <CircleOff className="size-3.5" /> Dismiss
                  </Button>
                </>
              )}
              {issue.status !== "open" && (
                <Button size="sm" variant="outline" disabled={updating} onClick={() => handleStatus("open")}>
                  Reopen
                </Button>
              )}
            </div>
          </div>

          {/* Session link */}
          {issue.session_id && (
            <div className="text-sm text-muted-foreground">
              First reported in session{" "}
              <button
                onClick={() => router.push(`/sessions/${issue.session_id}`)}
                className="font-mono text-foreground hover:underline"
              >
                {issue.session_id.slice(0, 8)}…
              </button>
            </div>
          )}

          {/* Body */}
          {issue.body && (
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">Description</p>
              <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed">{issue.body}</pre>
            </div>
          )}

          {/* Occurrences / comments */}
          {comments.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                Occurrences ({comments.length})
              </p>
              <div className="space-y-3">
                {comments.map((c: any) => (
                  <div key={c.id} className="rounded-lg border p-4">
                    <div className="flex items-center gap-3 mb-2">
                      {c.session_id && (
                        <button
                          onClick={() => router.push(`/sessions/${c.session_id}`)}
                          className="font-mono text-xs text-muted-foreground hover:text-foreground"
                        >
                          {c.session_id.slice(0, 8)}…
                        </button>
                      )}
                      <span className="text-xs text-muted-foreground">{formatRelative(c.created_at)}</span>
                    </div>
                    {c.body && (
                      <pre className="whitespace-pre-wrap text-sm font-sans text-muted-foreground leading-relaxed">{c.body}</pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
