"use client";

import { useMemo, useState } from "react";
import { Eye, EyeOff, Loader2, Pencil, Plus, X } from "lucide-react";

import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import {
  ENV_VARS_MAX_KEYS,
  isSensitiveKey,
  RESERVED_ENV_KEYS,
  validateEnvVars,
  type EnvVarValidationError,
} from "@/ui/lib/env-vars";

interface EnvVarsEditorProps {
  /** Current map from the agent. Undefined/null treated as empty. */
  value: Record<string, string> | null | undefined;
  /**
   * Called when the user clicks Save with a validated map. Returns a
   * promise so the editor can show an in-button spinner and surface
   * any backend error via `onError`.
   */
  onSave: (next: Record<string, string>) => Promise<void>;
  /**
   * Called when the PATCH succeeds and the editor wants to relay a
   * non-blocking error (e.g. server returned a 400 we didn't catch
   * client-side). The parent decides whether to render this inline or
   * in its own error strip.
   */
  onError: (msg: string) => void;
}

interface EditorRow {
  /** Stable key for React — not the env var name. */
  rowId: string;
  key: string;
  value: string;
  revealed: boolean;
}

let rowIdCounter = 0;
function nextRowId(): string {
  rowIdCounter += 1;
  return `r${rowIdCounter}`;
}

function toEditorRows(map: Record<string, string>): EditorRow[] {
  return Object.entries(map).map(([k, v]) => ({
    rowId: nextRowId(),
    key: k,
    value: v,
    revealed: false,
  }));
}

export function EnvVarsEditor({ value, onSave, onError }: EnvVarsEditorProps) {
  // Reserved keys (e.g. AGENT_REQUIREMENTS) are written by the backend but
  // rejected on PATCH. Filter them out at the boundary so they never leak into
  // delete-from-read or save-from-edit PATCH bodies. The server preserves them
  // across PATCHes, so dropping them from the editor's working state is safe.
  const current = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value ?? {})) {
      if (!RESERVED_ENV_KEYS.has(k)) out[k] = v;
    }
    return out;
  }, [value]);
  const keys = Object.keys(current);

  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<EditorRow[]>([]);
  const [saving, setSaving] = useState(false);
  // Per-row reveal state for the read view, keyed by env var name.
  const [revealedRead, setRevealedRead] = useState<Set<string>>(new Set());

  const errors: EnvVarValidationError[] = useMemo(
    () => (editing ? validateEnvVars(rows) : []),
    [editing, rows],
  );
  const errorsByRow = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const e of errors) {
      if (e.row === null) continue;
      const arr = m.get(e.row) ?? [];
      arr.push(e.message);
      m.set(e.row, arr);
    }
    return m;
  }, [errors]);
  const formErrors = errors.filter((e) => e.row === null).map((e) => e.message);
  const hasErrors = errors.length > 0;

  function openEditor(seed?: EditorRow[]) {
    const initial =
      seed ??
      (keys.length > 0
        ? toEditorRows(current)
        : [
            {
              rowId: nextRowId(),
              key: "",
              value: "",
              revealed: true,
            },
          ]);
    setRows(initial);
    setEditing(true);
  }

  function handleAddRow() {
    setRows((prev) => [
      ...prev,
      { rowId: nextRowId(), key: "", value: "", revealed: true },
    ]);
  }

  function handleRowChange(rowId: string, patch: Partial<EditorRow>) {
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  }

  function handleRemoveEditorRow(rowId: string) {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId));
  }

  function handleCancel() {
    setEditing(false);
    setRows([]);
  }

  async function handleSave() {
    if (hasErrors || saving) return;
    // Build the final map. Skip blank rows (no key — they're just empty
    // form rows the user left around).
    const finalMap: Record<string, string> = {};
    for (const r of rows) {
      if (r.key.trim() === "") continue;
      finalMap[r.key] = r.value;
    }
    setSaving(true);
    try {
      await onSave(finalMap);
      setEditing(false);
      setRows([]);
      setRevealedRead(new Set());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleDeleteFromRead(key: string) {
    // Build a new map without that key; PATCH immediately. Stays in
    // read-only mode — feels lighter than opening the editor for a delete.
    const next: Record<string, string> = { ...current };
    delete next[key];
    setSaving(true);
    void onSave(next)
      .catch((e) =>
        onError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setSaving(false));
  }

  function toggleReadReveal(key: string) {
    setRevealedRead((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // -------- Read view --------
  if (!editing) {
    if (keys.length === 0) {
      return (
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-muted-foreground">
            No environment variables set.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openEditor()}
            className="h-7 gap-1 px-2 text-[12px]"
          >
            <Plus className="size-3" />
            Add variable
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-1.5">
        <ul className="space-y-1">
          {keys.map((k) => {
            const v = current[k] ?? "";
            const sensitive = isSensitiveKey(k);
            const revealed = revealedRead.has(k);
            const masked = !revealed;
            return (
              <li
                key={k}
                className="flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5"
              >
                <code className="font-mono text-[12px] font-medium text-foreground">
                  {k}
                </code>
                <span className="text-[12px] text-muted-foreground">=</span>
                <code className="flex-1 truncate font-mono text-[12px] text-foreground">
                  {masked ? "••••••" : v || <em className="not-italic text-muted-foreground">(empty)</em>}
                </code>
                {sensitive && masked ? (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    sensitive
                  </Badge>
                ) : null}
                <button
                  type="button"
                  onClick={() => toggleReadReveal(k)}
                  className="inline-flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground focus-visible:outline-none"
                  aria-label={revealed ? `Hide ${k}` : `Show ${k}`}
                  title={revealed ? "Hide value" : "Show value"}
                >
                  {revealed ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteFromRead(k)}
                  disabled={saving}
                  className="inline-flex size-5 items-center justify-center rounded text-muted-foreground/60 hover:text-destructive focus-visible:outline-none disabled:opacity-50"
                  aria-label={`Delete ${k}`}
                  title="Delete this variable"
                >
                  <X className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-2 pt-0.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openEditor()}
            className="h-7 gap-1 px-2 text-[12px]"
          >
            <Pencil className="size-3" />
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              const seed = toEditorRows(current);
              seed.push({
                rowId: nextRowId(),
                key: "",
                value: "",
                revealed: true,
              });
              openEditor(seed);
            }}
            className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3" />
            Add variable
          </Button>
          {saving ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : null}
        </div>
      </div>
    );
  }

  // -------- Edit view --------
  const atKeyLimit = rows.length >= ENV_VARS_MAX_KEYS;
  return (
    <div className="space-y-2 rounded-md border bg-card/50 p-3">
      {rows.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No variables. Click <em className="not-italic font-medium">Add row</em> to start.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r, i) => {
            const rowNum = i + 1;
            const rowErrs = errorsByRow.get(rowNum) ?? [];
            const valueType = r.revealed ? "text" : "password";
            return (
              <li key={r.rowId} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <Input
                    aria-label={`Key for row ${rowNum}`}
                    value={r.key}
                    onChange={(e) =>
                      handleRowChange(r.rowId, { key: e.target.value })
                    }
                    placeholder="KEY"
                    aria-invalid={rowErrs.length > 0 ? true : undefined}
                    className="h-7 max-w-[200px] font-mono text-[12px]"
                  />
                  <span className="text-[12px] text-muted-foreground">=</span>
                  <Input
                    aria-label={`Value for row ${rowNum}`}
                    type={valueType}
                    value={r.value}
                    onChange={(e) =>
                      handleRowChange(r.rowId, { value: e.target.value })
                    }
                    placeholder="value"
                    className="h-7 flex-1 font-mono text-[12px]"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      handleRowChange(r.rowId, { revealed: !r.revealed })
                    }
                    className="inline-flex size-6 items-center justify-center rounded text-muted-foreground/80 hover:text-foreground focus-visible:outline-none"
                    aria-label={r.revealed ? "Hide value" : "Show value"}
                    title={r.revealed ? "Hide value" : "Show value"}
                  >
                    {r.revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveEditorRow(r.rowId)}
                    className="inline-flex size-6 items-center justify-center rounded text-muted-foreground/60 hover:text-destructive focus-visible:outline-none"
                    aria-label={`Remove row ${rowNum}`}
                    title="Remove this row"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {rowErrs.length > 0 ? (
                  <p className="pl-1 font-mono text-[11px] text-destructive">
                    {rowErrs.join("; ")}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddRow}
          disabled={atKeyLimit || saving}
          className="h-7 gap-1 px-2 text-[12px]"
        >
          <Plus className="size-3" />
          Add row
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            disabled={saving}
            className="h-7 px-2 text-[12px]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={hasErrors || saving}
            className="h-7 gap-1 px-3 text-[12px]"
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>

      {formErrors.length > 0 ? (
        <p className="font-mono text-[11px] text-destructive">
          {formErrors.join("; ")}
        </p>
      ) : null}
    </div>
  );
}
