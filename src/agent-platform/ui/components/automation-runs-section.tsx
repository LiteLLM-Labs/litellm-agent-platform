"use client";

/**
 * Automation runs preview for the agent detail page.
 *
 * Shows the most recent runs as a compact, clickable feed. Each row links to
 * the run detail page; the header links to the full runs table. Polls so a run
 * that fires while the page is open shows up without a manual refresh.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Loader2, RefreshCw } from "lucide-react";

import { AutomationRunRow, listAutomationRuns } from "@/ui/lib/api";
import {
  RunStatusBadge,
  runDuration,
  runRelativeTime,
} from "@/ui/components/automation-run-ui";

interface Props {
  agentId: string;
}

const POLL_MS = 15_000;
const PREVIEW_COUNT = 5;

export function AutomationRunsSection({ agentId }: Props) {
  const [runs, setRuns] = useState<AutomationRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRuns(await listAutomationRuns(agentId, 50));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  const total = runs?.length ?? 0;
  const preview = runs?.slice(0, PREVIEW_COUNT) ?? [];

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Automation runs</h2>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void reload()}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
          {total > 0 && (
            <Link
              href={`/agents/${encodeURIComponent(agentId)}/automation-runs`}
              className="flex items-center gap-0.5 text-xs font-medium text-foreground hover:underline"
            >
              View all{total > PREVIEW_COUNT ? ` (${total})` : ""}
              <ChevronRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      {runs === null ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        </div>
      ) : preview.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center text-sm text-muted-foreground">
          No runs yet. Runs show up here each time an automation fires.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border bg-card/40">
          {preview.map((run) => (
            <li key={run.id}>
              <Link
                href={`/agents/${encodeURIComponent(agentId)}/automation-runs/${encodeURIComponent(run.id)}`}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <RunStatusBadge status={run.status} />
                    <span className="truncate text-sm font-medium">
                      {run.automation_name || "Automation"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Started {runRelativeTime(run.started_at)}
                    {runDuration(run) && <> · took {runDuration(run)}</>}
                  </div>
                  {run.status === "failed" && run.error && (
                    <div className="mt-0.5 truncate font-mono text-xs text-destructive">
                      {run.error}
                    </div>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
