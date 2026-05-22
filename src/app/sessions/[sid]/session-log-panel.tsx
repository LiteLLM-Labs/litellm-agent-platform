"use client";

/**
 * Session Log side panel.
 *
 * A right-rail timeline of a session's events, read from the durable
 * SessionMessage log via GET /sessions/:id/log. Unlike the live message thread
 * this reads only the DB, so it renders for dead/expired sessions too and
 * surfaces lifecycle moments the chat doesn't — creation, and sandbox
 * recoveries (when a dead sandbox was transparently rehydrated).
 */

import { useCallback, useEffect, useState } from "react";
import {
  X,
  ScrollText,
  Sparkles,
  User,
  Bot,
  RefreshCw,
  Flag,
  Loader2,
} from "lucide-react";

import { getSessionLog, type SessionLogEvent } from "@/lib/api";

// Poll while open so an in-progress turn / recovery shows up without a manual
// refresh. Matches the session page's own polling cadence.
const POLL_MS = 4000;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function EventIcon({ kind }: { kind: SessionLogEvent["kind"] }) {
  switch (kind) {
    case "created":
      return <Sparkles className="size-3.5 text-violet-500" />;
    case "user":
      return <User className="size-3.5 text-blue-500" />;
    case "assistant":
      return <Bot className="size-3.5 text-emerald-600" />;
    case "recovered":
      return <RefreshCw className="size-3.5 text-amber-600" />;
    case "ended":
      return <Flag className="size-3.5 text-red-500" />;
    default:
      return <ScrollText className="size-3.5 text-gray-400" />;
  }
}

function statusBadge(status?: string) {
  if (!status || status === "complete") return null;
  const color =
    status === "failed"
      ? "bg-red-50 text-red-600 border-red-200"
      : "bg-amber-50 text-amber-700 border-amber-200";
  return (
    <span
      className={`ml-1 rounded border px-1 text-[9px] uppercase tracking-wide ${color}`}
    >
      {status}
    </span>
  );
}

export function SessionLogPanel({
  open,
  onClose,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}) {
  // null = not yet loaded (shows the header spinner); [] = loaded but empty.
  const [events, setEvents] = useState<SessionLogEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const evts = await getSessionLog(sessionId, { signal });
        if (!signal?.aborted) {
          setEvents(evts);
          setError(null);
        }
      } catch (e) {
        if (!signal?.aborted) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    // Standard load-on-open + poll. The lint rule flags calling an async loader
    // that setStates (same pattern as the page's own loadSession); the writes
    // happen post-await, off the synchronous render path.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(ctrl.signal);
    const id = window.setInterval(() => void load(ctrl.signal), POLL_MS);
    return () => {
      ctrl.abort();
      window.clearInterval(id);
    };
  }, [open, load]);

  if (!open) return null;

  return (
    <aside className="flex flex-col h-full min-h-0 border-l border-gray-200 bg-white w-[400px] shrink-0">
      <header className="flex items-center gap-2 px-4 py-2 border-b border-gray-200">
        <ScrollText className="size-3.5 text-gray-500" />
        <span className="text-[13px] font-medium text-gray-800">
          Session Log
        </span>
        <span className="font-mono text-[11px] text-gray-400">
          session {sessionId.slice(0, 8)}…
        </span>
        {events === null && !error && (
          <Loader2 className="size-3 text-gray-400 animate-spin" />
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto p-1 hover:bg-gray-100 rounded"
          title="Close session log"
        >
          <X className="size-4 text-gray-500" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 bg-gray-50/30">
        {error && (
          <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-600">
            {error}
          </div>
        )}
        {events !== null && events.length === 0 && !error ? (
          <div className="text-[12px] text-gray-400 px-1 py-4 text-center">
            No events yet.
          </div>
        ) : (
          <ol className="flex flex-col">
            {(events ?? []).map((e, i) => (
              <li key={e.id} className="relative flex gap-2.5 pb-3">
                {/* connector line */}
                {i < (events ?? []).length - 1 && (
                  <span
                    aria-hidden
                    className="absolute left-[6.5px] top-4 bottom-0 w-px bg-gray-200"
                  />
                )}
                <span className="relative z-10 mt-0.5 flex size-3.5 items-center justify-center">
                  <EventIcon kind={e.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span
                      className={`text-[12px] font-medium ${
                        e.kind === "recovered"
                          ? "text-amber-700"
                          : e.kind === "ended"
                            ? "text-red-600"
                            : "text-gray-800"
                      }`}
                    >
                      {e.title}
                    </span>
                    {statusBadge(e.status)}
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-gray-400">
                      {fmtTime(e.at)}
                    </span>
                  </div>
                  {e.detail && (
                    <p
                      className={`mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-snug ${
                        e.kind === "recovered"
                          ? "text-amber-600"
                          : "text-gray-500"
                      }`}
                    >
                      {e.detail}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer className="px-4 py-1.5 border-t border-gray-200 text-[10px] text-gray-400 font-mono">
        durable session log · survives sandbox restarts
      </footer>
    </aside>
  );
}
