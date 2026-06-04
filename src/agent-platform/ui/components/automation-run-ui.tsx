"use client";

/**
 * Shared rendering bits for automation runs — used by the agent-page preview
 * (automation-runs-section), the full runs table page, and the run detail page
 * so they stay visually consistent.
 */

import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Badge } from "@/ui/components/ui/badge";
import type { AutomationRunRow } from "@/ui/lib/api";

/** Compact relative time, e.g. "3m ago". */
export function runRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** Run duration as a short string, or null while still running. */
export function runDuration(run: AutomationRunRow): string | null {
  if (!run.finished_at) return null;
  const ms =
    new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export function RunStatusBadge({ status }: { status: string }) {
  if (status === "succeeded") {
    return (
      <Badge variant="default" className="font-normal">
        <CheckCircle2 className="h-3 w-3" />
        Succeeded
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="font-normal">
        <XCircle className="h-3 w-3" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-normal">
      <Loader2 className="h-3 w-3 animate-spin" />
      Running
    </Badge>
  );
}
