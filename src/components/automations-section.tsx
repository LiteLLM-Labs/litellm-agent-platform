"use client";

/**
 * Automations section for the agent detail page.
 *
 * Lists the agent's scheduled triggers and lets the user add / pause /
 * delete them. Each automation fires a session on a cron cadence (evaluated
 * in UTC) with a fixed instruction as the initial prompt — see
 * src/server/automations.ts for the worker that runs them.
 *
 * Renders independently of the agent edit form: its own fetch + mutations,
 * not part of the form submit.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { Check, Clock, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AutomationRow,
  createAutomation,
  deleteAutomation,
  listAutomations,
  runAutomationNow,
  updateAutomation,
} from "@/lib/api";

interface Props {
  agentId: string;
}

// Preset schedules surfaced in the add form. The human label is the Select
// option value (this Select renders the value verbatim in the trigger, so a
// raw cron there is unreadable); the cron is looked up from the label on save.
// "Custom cron…" drops to a free-text cron input for anything else.
const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
  { label: "Every 10 minutes", cron: "*/10 * * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at midnight UTC", cron: "0 0 * * *" },
  { label: "Daily at 9 AM UTC", cron: "0 9 * * *" },
  { label: "Weekdays at 9 AM UTC", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 9 AM UTC", cron: "0 9 * * 1" },
];

const CUSTOM_LABEL = "Custom cron…";
const DEFAULT_SCHEDULE_LABEL = "Every 10 minutes";

/** Human label for a stored cron expression — falls back to the raw cron. */
function humanizeCron(cron: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.cron === cron);
  return preset ? preset.label : cron;
}

export function AutomationsSection({ agentId }: Props) {
  const [automations, setAutomations] = useState<AutomationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [ranId, setRanId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setAutomations(await listAutomations(agentId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleToggle = async (auto: AutomationRow) => {
    setBusyId(auto.id);
    try {
      await updateAutomation(agentId, auto.id, { enabled: !auto.enabled });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    try {
      await deleteAutomation(agentId, id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Fire an automation immediately for testing. The spawned run shows up in the
  // run log on its next poll; here we just flash a ✓ on the button.
  const handleRunNow = async (id: string) => {
    setRunningId(id);
    try {
      await runAutomationNow(agentId, id);
      setRanId(id);
      setTimeout(() => setRanId((cur) => (cur === id ? null : cur)), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningId(null);
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Automations</h2>
        <p className="text-xs text-muted-foreground">
          Run this agent on a schedule.
        </p>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      {automations === null ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        </div>
      ) : automations.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center text-sm text-muted-foreground">
          No automations yet. Add one to run this agent on a schedule.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border bg-card/40">
          {automations.map((auto) =>
            editingId === auto.id ? (
              <li key={auto.id} className="p-3">
                <AutomationForm
                  initial={{
                    instruction: auto.instruction,
                    cron_expr: auto.cron_expr,
                  }}
                  submitLabel="Save changes"
                  onSubmit={async (values) => {
                    await updateAutomation(agentId, auto.id, values);
                    setEditingId(null);
                    await reload();
                  }}
                  onCancel={() => setEditingId(null)}
                  onError={setError}
                />
              </li>
            ) : (
              <AutomationItem
                key={auto.id}
                automation={auto}
                busy={busyId === auto.id}
                running={runningId === auto.id}
                ran={ranId === auto.id}
                onRun={() => handleRunNow(auto.id)}
                onEdit={() => {
                  setAdding(false);
                  setEditingId(auto.id);
                }}
                onToggle={() => handleToggle(auto)}
                onDelete={() => handleDelete(auto.id)}
              />
            ),
          )}
        </ul>
      )}

      {adding ? (
        <AutomationForm
          submitLabel="Save"
          onSubmit={async (values) => {
            await createAutomation(agentId, values);
            setAdding(false);
            await reload();
          }}
          onCancel={() => setAdding(false)}
          onError={setError}
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => {
            setEditingId(null);
            setAdding(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="ml-1.5">Add automation</span>
        </Button>
      )}
    </section>
  );
}

interface ItemProps {
  automation: AutomationRow;
  busy: boolean;
  running: boolean;
  ran: boolean;
  onRun: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}

function AutomationItem({
  automation,
  busy,
  running,
  ran,
  onRun,
  onEdit,
  onToggle,
  onDelete,
}: ItemProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="px-4 py-3">
      {/* Top row: title + status on the left, actions on the right — both
          vertically centered on the same line so nothing staggers. */}
      <div className="flex items-center justify-between gap-4">
        <div
          className="flex min-w-0 cursor-pointer items-center gap-2"
          onClick={() => setExpanded((v) => !v)}
          title="Click to expand"
        >
          <span className={`text-sm font-medium${expanded ? "" : " truncate"}`}>
            {automation.name || automation.instruction}
          </span>
          {automation.enabled ? (
            <Badge variant="default" className="shrink-0 font-normal">
              Enabled
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="shrink-0 font-normal text-muted-foreground"
            >
              Paused
            </Badge>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onRun} disabled={busy || running}>
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : ran ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5">{ran ? "Started" : "Run now"}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            disabled={busy || running}
            aria-label="Edit automation"
          >
            <Pencil className="h-3.5 w-3.5" />
            <span className="ml-1.5">Edit</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={onToggle} disabled={busy}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : automation.enabled ? (
              "Pause"
            ) : (
              "Resume"
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={busy}
            aria-label="Delete automation"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3 shrink-0" />
        <span className="font-mono">{humanizeCron(automation.cron_expr)}</span>
        {automation.enabled && automation.next_run_at && (
          <span>· next {new Date(automation.next_run_at).toLocaleString()}</span>
        )}
      </div>
      {automation.name && (
        <div className={`mt-0.5 text-xs text-muted-foreground${expanded ? "" : " truncate"}`}>
          {automation.instruction}
        </div>
      )}
    </li>
  );
}

/** Resolve a stored cron back to its preset label, or "Custom cron…". */
function cronToScheduleLabel(cron: string): string {
  return SCHEDULE_PRESETS.find((p) => p.cron === cron)?.label ?? CUSTOM_LABEL;
}

interface FormProps {
  // When present, the form edits this automation; otherwise it creates a new one.
  initial?: { instruction: string; cron_expr: string };
  submitLabel: string;
  onSubmit: (values: { instruction: string; cron_expr: string }) => Promise<void>;
  onCancel: () => void;
  onError: (msg: string) => void;
}

function AutomationForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  onError,
}: FormProps) {
  const [instruction, setInstruction] = useState(initial?.instruction ?? "");
  // The Select value is the human label (shown verbatim in the trigger); the
  // cron is resolved from it on save. When editing a custom cron, start on the
  // custom option with the stored expression pre-filled.
  const initialLabel = initial
    ? cronToScheduleLabel(initial.cron_expr)
    : DEFAULT_SCHEDULE_LABEL;
  const [scheduleLabel, setScheduleLabel] = useState(initialLabel);
  const [customCron, setCustomCron] = useState(
    initial && initialLabel === CUSTOM_LABEL ? initial.cron_expr : "",
  );
  const [saving, setSaving] = useState(false);
  // Unique per form instance so an add + edit form on screen at once can't
  // collide on the same DOM id (which would break label association).
  const instructionId = useId();

  const isCustom = scheduleLabel === CUSTOM_LABEL;
  const cronExpr = isCustom
    ? customCron.trim()
    : (SCHEDULE_PRESETS.find((p) => p.label === scheduleLabel)?.cron ?? "");
  const canSave = instruction.trim().length > 0 && cronExpr.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSubmit({ instruction: instruction.trim(), cron_expr: cronExpr });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-card/40 p-4">
      <div className="space-y-1.5">
        <Label htmlFor={instructionId}>Instruction</Label>
        <Textarea
          id={instructionId}
          rows={3}
          placeholder="What should the agent do each time this runs?"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Schedule</Label>
        <Select
          value={scheduleLabel}
          onValueChange={(v) => v && setScheduleLabel(v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_PRESETS.map((p) => (
              <SelectItem key={p.label} value={p.label}>
                {p.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_LABEL}>{CUSTOM_LABEL}</SelectItem>
          </SelectContent>
        </Select>
        {isCustom && (
          <Input
            className="font-mono"
            placeholder="0 9 * * 1-5"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
          />
        )}
        <p className="text-xs text-muted-foreground">
          5-field cron, evaluated in UTC.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!canSave}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : submitLabel}
        </Button>
      </div>
    </div>
  );
}
