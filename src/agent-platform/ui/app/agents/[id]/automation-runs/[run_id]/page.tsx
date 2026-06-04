"use client";

/**
 * /agents/:id/automation-runs/:run_id — full detail for a single run: status,
 * timing, the automation it ran (instruction + schedule), the full error if it
 * failed, and a link into the session it spawned. Backed by
 * GET /api/v1/managed_agents/agents/:id/automation-runs/:run_id.
 */

import { use, useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/ui/components/ui/button";
import {
  ApiError,
  AutomationRunRow,
  getAutomationRun,
} from "@/ui/lib/api";
import {
  RunStatusBadge,
  runDuration,
} from "@/ui/components/automation-run-ui";

interface PageProps {
  params: Promise<{ id: string; run_id: string }>;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 px-4 py-3">
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export default function AutomationRunDetailPage({ params }: PageProps) {
  const router = useRouter();
  const { id, run_id } = use(params);

  const [run, setRun] = useState<AutomationRunRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setRun(await getAutomationRun(id, run_id));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [id, run_id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <button
        onClick={() => router.push(`/agents/${id}/automation-runs`)}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to runs
      </button>

      {loading ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-16 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        </div>
      ) : err ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {err}
        </div>
      ) : run ? (
        <>
          <header className="mb-6 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <RunStatusBadge status={run.status} />
              <h1 className="text-xl font-semibold tracking-tight">
                {run.automation_name || "Automation run"}
              </h1>
            </div>
            {run.session_id && (
              <Button
                size="sm"
                onClick={() => router.push(`/sessions/${run.session_id}`)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span className="ml-1.5">Open session</span>
              </Button>
            )}
          </header>

          <dl className="divide-y rounded-lg border bg-card/40">
            <Field label="Status">{run.status}</Field>
            <Field label="Started">{fmt(run.started_at)}</Field>
            <Field label="Finished">{fmt(run.finished_at)}</Field>
            <Field label="Duration">{runDuration(run) ?? "still running"}</Field>
            <Field label="Schedule">
              {run.automation_cron ? (
                <span className="font-mono">{run.automation_cron}</span>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Instruction">
              {run.automation_instruction ? (
                <p className="whitespace-pre-wrap break-words">
                  {run.automation_instruction}
                </p>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Session">
              {run.session_id ? (
                <a
                  href={`/sessions/${encodeURIComponent(run.session_id)}`}
                  className="font-mono text-sm underline hover:text-foreground"
                >
                  {run.session_id}
                </a>
              ) : (
                <span className="text-muted-foreground">
                  No session — bring-up never started.
                </span>
              )}
            </Field>
            {run.error && (
              <Field label="Error">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs text-destructive">
                  {run.error}
                </pre>
              </Field>
            )}
          </dl>

          <p className="mt-4 text-xs text-muted-foreground">
            The run&apos;s full activity lives in its session. Open the session
            to see what the agent actually did.
          </p>
        </>
      ) : null}
    </div>
  );
}
