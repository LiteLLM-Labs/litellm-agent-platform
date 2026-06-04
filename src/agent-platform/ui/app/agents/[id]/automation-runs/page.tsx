"use client";

/**
 * /agents/:id/automation-runs — full table of every automation run for the
 * agent, newest first. Each row links to the run detail page. Backed by
 * GET /api/v1/managed_agents/agents/:id/automation-runs.
 */

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/ui/table";
import {
  AgentRow,
  ApiError,
  AutomationRunRow,
  getAgent,
  listAutomationRuns,
} from "@/ui/lib/api";
import {
  RunStatusBadge,
  runDuration,
  runRelativeTime,
} from "@/ui/components/automation-run-ui";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function AutomationRunsPage({ params }: PageProps) {
  const router = useRouter();
  const { id } = use(params);

  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [runs, setRuns] = useState<AutomationRunRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [a, r] = await Promise.all([
        getAgent(id),
        listAutomationRuns(id, 200),
      ]);
      setAgent(a);
      setRuns(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <button
        onClick={() => router.push(`/agents/${id}`)}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to agent
      </button>

      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Automation runs{agent?.name ? ` · ${agent.name}` : ""}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every time an automation fired, and how it finished.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </header>

      {err && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {err}
        </div>
      )}

      {runs === null ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-16 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-16 text-center text-sm text-muted-foreground">
          No runs yet. Runs show up here each time an automation fires.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card/40">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Automation</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow
                  key={run.id}
                  onClick={() =>
                    router.push(`/agents/${id}/automation-runs/${run.id}`)
                  }
                  className="cursor-pointer"
                >
                  <TableCell>
                    <RunStatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="max-w-[20rem] truncate font-medium">
                    {run.automation_name || "Automation"}
                    {run.status === "failed" && run.error && (
                      <span className="ml-2 font-mono text-xs font-normal text-destructive">
                        {run.error}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {runRelativeTime(run.started_at)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {runDuration(run) ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">View →</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
