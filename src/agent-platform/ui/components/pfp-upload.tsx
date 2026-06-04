"use client";

import { ChangeEvent, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";

import { AgentAvatar } from "@/ui/components/agent-avatar";
import { Button } from "@/ui/components/ui/button";

const MAX_BYTES = 200_000;
const ACCEPTED = "image/jpeg,image/png,image/webp,image/gif";

interface PfpUploadProps {
  name?: string | null;
  /** Current value (data URL or remote URL). */
  value?: string | null;
  onChange: (next: string | null) => void;
  /** Avatar size in px. */
  size?: number;
  disabled?: boolean;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export function PfpUpload({
  name,
  value,
  onChange,
  size = 64,
  disabled,
}: PfpUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Pick an image file (jpg, png, webp, or gif).");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(
        `Max ${(MAX_BYTES / 1000).toFixed(0)}KB. This file is ${(file.size / 1000).toFixed(0)}KB.`,
      );
      return;
    }
    try {
      const url = await readAsDataUrl(file);
      onChange(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label="Upload profile picture"
        className="group relative shrink-0 cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed"
      >
        <AgentAvatar name={name} pfpUrl={value} size={size} />
        <span
          className="absolute inset-0 grid place-items-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        >
          <Pencil className="size-4 text-white" />
        </span>
      </button>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
          >
            {value ? "Replace" : "Upload"}
          </Button>
          {value ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(null)}
              disabled={disabled}
              aria-label="Remove profile picture"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
              Remove
            </Button>
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground">
          jpg / png / webp / gif &middot; up to {(MAX_BYTES / 1000).toFixed(0)}KB
        </p>
        {error ? (
          <p className="font-mono text-[11px] text-destructive">{error}</p>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        onChange={handleFile}
        className="hidden"
      />
    </div>
  );
}
