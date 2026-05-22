"use client";

/**
 * Automations section for the agent edit page.
 *
 * Shows a list of active cron-triggered automations. Each row fires a new
 * session with the configured instruction whenever the schedule fires.
 *
 * States:
 *   - Loading: spinner
 *   - Empty: "No automations yet" + Add button
 *   - Populated: list of rows + Add button
 *   - Adding: inline form slides in below the list
 */

import { useCallback, useEffect, useState } from "react";
import { Clock, Loader2, Plus, Trash2, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AutomationRow } from "@/lib/api";
import {
  ApiError,
  createAutomation,
  deleteAutomation,
  listAutomations,
  updateAutomation,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Cron preset options shown in the schedule picker.
// ---------------------------------------------------------------------------

const SCHEDULE_PRESETS = [
  { label: "Every hour",                value: "0 * * * *" },
  { label: "Every 2 hours",             value: "0 */2 * * *" },
  { label: "Every 6 hours",             value: "0 */6 * * *" },
  { label: "Every 12 hours",            value: "0 */12 * * *" },
  { label: "Daily at midnight (UTC)",   value: "0 0 * * *" },
  { label: "Daily at 9 am (UTC)",       value: "0 9 * * *" },
  { label: "Weekdays at 9 am (UTC)",    value: "0 9 * * 1-5" },
  { label: "Weekly on Monday 9 am (UTC)", value: "0 9 * * 1" },
  { label: "Monthly on the 1st (UTC)", value: "0 0 1 * *" },
  { label: "Custom…",                   value: "__custom__" },
] as const;

/** Human-readable label for a cron expression (matches server-side cronLabel). */
function cronLabel(expr: string): string {
  const hit = SCHEDULE_PRESETS.find(
    (p) => p.value === expr && p.value !== "__custom__",
  );
  return hit ? hit.label : expr;
}

/** Format a UTC ISO string as a short local time string. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  agentId: string;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AutomationsSection({ agentId }: Props) {
  const [automations, setAutomations] = useState<AutomationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await listAutomations(agentId);
      setAutomations(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreated = async () => {
    setShowForm(false);
    await reload();
  };

  const handleToggle = async (row: AutomationRow) => {
    try {
      const updated = await updateAutomation(agentId, row.automation_id, {
        enabled: !row.enabled,
      });
      setAutomations((prev) =>
        prev?.map((a) => (a.automation_id === updated.automation_id ? updated : a)) ?? null,
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const handleDelete = async (automationId: string) => {
    try {
      await deleteAutomation(agentId, automationId);
      setAutomations((prev) => prev?.filter((a) => a.automation_id !== automationId) ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-muted-foreground" />
          <h2 className="text-[13px] font-semibold">Automations</h2>
          {automations && automations.length > 0 && (
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {automations.length}
            </span>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setShowForm((v) => !v)}
          className="h-7 gap-1 px-2 text-[12px]"
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>

      <p className="text-[12px] text-muted-foreground">
        Automatically run this agent on a recurring schedule. Each trigger spawns
        a new session with the configured instruction as its initial prompt.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      {/* List */}
      {automations === null ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed bg-card/40 py-8">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : automations.length === 0 && !showForm ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center text-[13px] text-muted-foreground">
          No automations yet.{" "}
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Add one
          </button>{" "}
          to run this agent on a schedule.
        </div>
      ) : automations.length > 0 ? (
        <ul className="divide-y rounded-lg border bg-card">
          {automations.map((a) => (
            <AutomationItem
              key={a.automation_id}
              row={a}
              onToggle={() => void handleToggle(a)}
              onDelete={() => void handleDelete(a.automation_id)}
            />
          ))}
        </ul>
      ) : null}

      {/* Inline add form */}
      {showForm && (
        <AddAutomationForm
          agentId={agentId}
          onCreated={handleCreated}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single automation row
// ---------------------------------------------------------------------------

interface AutomationItemProps {
  row: AutomationRow;
  onToggle: () => void;
  onDelete: () => void;
}

function AutomationItem({ row, onToggle, onDelete }: AutomationItemProps) {
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const label = row.name?.trim() || row.instruction.slice(0, 80) + (row.instruction.length > 80 ? "…" : "");

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      {/* Left — status dot */}
      <div className="mt-1 flex shrink-0 items-center">
        <span
          className={
            "inline-block size-2 rounded-full " +
            (row.enabled ? "bg-emerald-500" : "bg-muted-foreground/40")
          }
          title={row.enabled ? "Active" : "Paused"}
        />
      </div>

      {/* Middle — content */}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[13px] font-medium leading-snug">{label}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1 font-mono text-[11px]">
            <Clock className="size-3" />
            {cronLabel(row.cron_expr)}
          </Badge>
          {row.next_run_at && row.enabled && (
            <span className="text-[11px] text-muted-foreground">
              Next: {formatDate(row.next_run_at)}
            </span>
          )}
          {row.last_run_at && (
            <span className="text-[11px] text-muted-foreground">
              Last: {formatDate(row.last_run_at)}
            </span>
          )}
        </div>
        {/* Full instruction preview on a separate line when there's a name */}
        {row.name?.trim() && (
          <p className="text-[11px] text-muted-foreground line-clamp-2">
            {row.instruction}
          </p>
        )}
      </div>

      {/* Right — actions */}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={async () => {
            setToggling(true);
            try { await onToggle(); } finally { setToggling(false); }
          }}
          disabled={toggling}
          className="h-7 px-2 text-[12px] text-muted-foreground hover:text-foreground"
        >
          {toggling ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            row.enabled ? "Pause" : "Resume"
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={async () => {
            setDeleting(true);
            try { await onDelete(); } finally { setDeleting(false); }
          }}
          disabled={deleting}
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          aria-label="Delete automation"
        >
          {deleting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
        </Button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Add automation form
// ---------------------------------------------------------------------------

interface AddFormProps {
  agentId: string;
  onCreated: () => void;
  onCancel: () => void;
}

function AddAutomationForm({ agentId, onCreated, onCancel }: AddFormProps) {
  const [instruction, setInstruction] = useState("");
  const [schedulePreset, setSchedulePreset] = useState<string>("0 9 * * *");
  const [customCron, setCustomCron] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCustom = schedulePreset === "__custom__";
  const cronExpr = isCustom ? customCron.trim() : schedulePreset;

  const handleSubmit = async () => {
    if (!instruction.trim()) {
      setError("Instruction is required.");
      return;
    }
    if (!cronExpr) {
      setError("Schedule is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createAutomation(agentId, {
        instruction: instruction.trim(),
        cron_expr: cronExpr,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card/60 p-4 space-y-4">
      <h3 className="text-[13px] font-medium">New automation</h3>

      {error && (
        <p className="font-mono text-[11px] text-destructive">{error}</p>
      )}

      {/* Instruction */}
      <div className="space-y-1.5">
        <Label className="text-[12px]">
          Instruction
          <span className="ml-1 text-muted-foreground font-normal">(sent as the initial prompt)</span>
        </Label>
        <Textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. Check for open pull requests and add a review summary to each one."
          rows={3}
          className="resize-none font-mono text-[12px]"
          disabled={saving}
        />
      </div>

      {/* Schedule */}
      <div className="space-y-1.5">
        <Label className="text-[12px]">Schedule (UTC)</Label>
        <Select
          value={schedulePreset}
          onValueChange={(v) => { if (v !== null) setSchedulePreset(v); }}
          disabled={saving}
        >
          <SelectTrigger className="h-8 text-[12px]">
            <SelectValue placeholder="Select a schedule…" />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value} className="text-[12px]">
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isCustom && (
          <div className="space-y-1">
            <input
              type="text"
              value={customCron}
              onChange={(e) => setCustomCron(e.target.value)}
              placeholder="e.g. 0 9 * * 1-5"
              className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 font-mono text-[12px] shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              disabled={saving}
            />
            <p className="text-[11px] text-muted-foreground">
              Standard 5-field cron: minute hour day month weekday (UTC).
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={saving || !instruction.trim() || !cronExpr}
        >
          {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          {saving ? "Saving…" : "Save automation"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
