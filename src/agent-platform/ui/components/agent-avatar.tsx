"use client";

import Image from "next/image";

import { cn } from "@/ui/lib/utils";

interface AgentAvatarProps {
  name?: string | null;
  pfpUrl?: string | null;
  /** px size — translates to both rendered dimensions and the Image priority hint. */
  size?: number;
  className?: string;
}

const PALETTE = [
  "bg-rose-100 text-rose-700",
  "bg-amber-100 text-amber-800",
  "bg-emerald-100 text-emerald-800",
  "bg-sky-100 text-sky-800",
  "bg-violet-100 text-violet-800",
  "bg-pink-100 text-pink-800",
  "bg-teal-100 text-teal-800",
  "bg-indigo-100 text-indigo-800",
];

function pickColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function initial(name?: string | null): string {
  const trimmed = name?.trim();
  if (!trimmed) return "?";
  const first = trimmed[0];
  return first.toUpperCase();
}

export function AgentAvatar({
  name,
  pfpUrl,
  size = 32,
  className,
}: AgentAvatarProps) {
  const dim = `${size}px`;
  const fontSize = `${Math.max(10, Math.floor(size * 0.42))}px`;

  if (pfpUrl) {
    // next/image's domains/remote-patterns config doesn't accept arbitrary
    // hosts and refuses data: URLs entirely. PFPs are stored as data URIs or
    // arbitrary URLs, so use a plain img — the alternative is a costly
    // next.config dance for what is, by design, untrusted user content.
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={pfpUrl}
        alt={name?.trim() || "agent"}
        width={size}
        height={size}
        className={cn(
          "shrink-0 rounded-full object-cover ring-1 ring-border",
          className,
        )}
        style={{ width: dim, height: dim }}
      />
    );
  }

  // Suppress unused-import warning when we don't render <Image />.
  void Image;

  const seed = name?.trim() || "?";
  return (
    <span
      aria-label={name?.trim() || "agent"}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full font-medium ring-1 ring-border/50",
        pickColor(seed),
        className,
      )}
      style={{ width: dim, height: dim, fontSize }}
    >
      {initial(name)}
    </span>
  );
}
