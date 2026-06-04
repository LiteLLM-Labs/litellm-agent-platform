"use client";

/**
 * Allowed-hosts (egress) editor for an agent. Pick from well-known presets
 * (GitHub / Linear / OpenAI / …) or add custom hosts. The agent's outbound
 * traffic is restricted to these hosts, and each credential can only be bound
 * to a host that appears here. Controlled — parent owns the `string[]`.
 */

import { useState } from "react";
import { Plus, X } from "lucide-react";

import { Input } from "@/ui/components/ui/input";
import { cn } from "@/ui/lib/utils";
import { WELL_KNOWN_HOSTS, isValidEgressHost } from "@/shared/egress-hosts";

interface EgressHostsEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Show a "required" hint when empty (agent forms gate submit on this). */
  required?: boolean;
}

export function EgressHostsEditor({ value, onChange, disabled, required }: EgressHostsEditorProps) {
  const [custom, setCustom] = useState("");
  const selected = new Set(value);

  function addHosts(hosts: string[]) {
    const next = [...value];
    for (const h of hosts) if (!next.includes(h)) next.push(h);
    onChange(next);
  }
  function removeHost(h: string) {
    onChange(value.filter((x) => x !== h));
  }
  function addCustom() {
    const h = custom.trim();
    if (!h || !isValidEgressHost(h) || selected.has(h)) return;
    addHosts([h]);
    setCustom("");
  }

  const customValid = custom.trim() === "" || isValidEgressHost(custom.trim());

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {WELL_KNOWN_HOSTS.map((p) => {
          const active = p.hosts.every((h) => selected.has(h));
          return (
            <button
              key={p.id}
              type="button"
              disabled={disabled}
              onClick={() =>
                active
                  ? onChange(value.filter((h) => !p.hosts.includes(h)))
                  : addHosts(p.hosts)
              }
              className={cn(
                "rounded-full border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-40",
                active
                  ? "border-foreground bg-foreground text-background"
                  : "text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((h) => (
            <li
              key={h}
              className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[11px]"
            >
              {h}
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeHost(h)}
                aria-label={`Remove ${h}`}
                className="text-muted-foreground hover:text-destructive disabled:opacity-40"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-1.5">
        <Input
          value={custom}
          disabled={disabled}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="api.example.com or *.example.com"
          aria-invalid={!customValid || undefined}
          className="h-7 flex-1 font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          disabled={disabled || custom.trim() === "" || !customValid}
          onClick={addCustom}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-3" />
          Add
        </button>
      </div>

      {!customValid ? (
        <p className="font-mono text-[11px] text-destructive">
          Invalid host — use a domain, *.wildcard, IP, or CIDR.
        </p>
      ) : null}
      {required && value.length === 0 ? (
        <p className="text-[11px] text-destructive">
          Add at least one host this secret may be sent to.
        </p>
      ) : null}
    </div>
  );
}
