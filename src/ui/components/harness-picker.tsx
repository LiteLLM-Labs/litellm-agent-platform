"use client";

import { Check, MessageSquare, Terminal } from "lucide-react";
import { cn } from "@/ui/lib/utils";

export type HarnessMode = "CHAT" | "TUI";

export interface HarnessOption {
  id: string;
  label: string;
  description: string;
  mode: HarnessMode;
}

export const HARNESS_OPTIONS: HarnessOption[] = [
  {
    id: "claude-code-brain-inline",
    label: "claude-code-brain-inline",
    description: "Brain runs on the platform — no sandbox warmup. Claude provisions compute on demand when it needs to run code.",
    mode: "CHAT",
  },
  {
    id: "opencode-brain-inline",
    label: "opencode-brain-inline",
    description: "opencode running inline on the platform — no sandbox warmup. Multi-provider via LiteLLM; provisions compute on demand when it needs to run code.",
    mode: "CHAT",
  },
  {
    id: "opencode",
    label: "opencode",
    description: "Multi-provider via LiteLLM. Default — used by every existing agent.",
    mode: "CHAT",
  },
  {
    id: "claude-agent-sdk",
    label: "claude-agent-sdk",
    description: "Anthropic's first-party agent loop. Fewer harness bugs; SDK persists session state for free.",
    mode: "CHAT",
  },
  {
    id: "claude-code",
    label: "claude-code",
    description: "Claude Code CLI, running in the sandbox. Opens as a live TUI in your browser via xterm.js.",
    mode: "TUI",
  },
  {
    id: "codex",
    label: "codex",
    description: "OpenAI Codex CLI, running in the sandbox. Opens as a live TUI in your browser via xterm.js.",
    mode: "TUI",
  },
  {
    id: "hermes",
    label: "hermes",
    description: "Nous Research Hermes Agent, running in the sandbox. Self-improving CLI with persistent memory + skills. Opens as a live TUI via xterm.js.",
    mode: "TUI",
  },
  {
    id: "gemini",
    label: "gemini",
    description: "Google Gemini CLI, running in the sandbox. Routes through the LiteLLM gateway via the /gemini passthrough. Opens as a live TUI via xterm.js.",
    mode: "TUI",
  },
];

export const DEFAULT_HARNESS_ID = "opencode";

const MODE_CLASS: Record<HarnessMode, string> = {
  CHAT: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  TUI: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
};

interface HarnessPickerProps {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function HarnessPicker({ value, onChange, disabled }: HarnessPickerProps) {
  return (
    <div>
      <ul role="radiogroup" aria-label="Harness" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {HARNESS_OPTIONS.map((opt) => {
          const selected = opt.id === value;
          const ModeIcon = opt.mode === "CHAT" ? MessageSquare : Terminal;
          return (
            <li key={opt.id}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange(opt.id)}
                disabled={disabled}
                className={cn(
                  "flex h-full min-h-[102px] w-full flex-col justify-between rounded-lg border bg-background/50 px-3 py-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60",
                  selected
                    ? "border-foreground/70 bg-accent/40 shadow-sm"
                    : "border-border",
                )}
              >
                <span className="flex items-start justify-between gap-3">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase",
                      MODE_CLASS[opt.mode],
                    )}
                  >
                    <ModeIcon className="size-3" />
                    {opt.mode}
                  </span>
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                      selected
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-transparent",
                    )}
                    aria-hidden
                  >
                    {selected ? <Check className="size-3" /> : null}
                  </span>
                </span>
                <span className="mt-3 flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate font-mono text-[13px] text-foreground">{opt.label}</span>
                  <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {opt.description}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
