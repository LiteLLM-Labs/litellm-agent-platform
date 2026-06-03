"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { CheckCircle2, Loader2, Settings } from "lucide-react";

import { Button } from "@/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/ui/dialog";
import { Input } from "@/ui/components/ui/input";
import { Label } from "@/ui/components/ui/label";
import {
  ApiError,
  LiteLLMGatewayStatus,
  getLiteLLMGatewayStatus,
  updateLiteLLMGateway,
} from "@/ui/lib/api";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Request failed.";
}

interface LiteLLMGatewayFormProps {
  status: LiteLLMGatewayStatus | null;
  onSaved?: (status: LiteLLMGatewayStatus) => void;
  autoFocus?: boolean;
}

export function LiteLLMGatewayForm({
  status,
  onSaved,
  autoFocus = false,
}: LiteLLMGatewayFormProps) {
  const [baseUrl, setBaseUrl] = useState(status?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setBaseUrl(status?.base_url ?? "");
  }, [status?.base_url]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await updateLiteLLMGateway({
        base_url: baseUrl.trim(),
        api_key: apiKey.trim(),
      });
      setApiKey("");
      setSaved(true);
      onSaved?.(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = baseUrl.trim().length > 0 && apiKey.trim().length > 0;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="litellm-base-url">Base URL</Label>
        <Input
          id="litellm-base-url"
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://gateway.example.com"
          autoFocus={autoFocus}
          disabled={saving}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="litellm-api-key">API key</Label>
        <Input
          id="litellm-api-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={status?.has_api_key ? "Enter a new key to replace it" : "sk-..."}
          autoComplete="new-password"
          disabled={saving}
        />
      </div>
      <div className="flex min-h-5 items-center gap-2 text-sm">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : saved ? (
          <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" aria-hidden />
            Saved
          </span>
        ) : status?.configured ? (
          <span className="text-muted-foreground">Gateway configured</span>
        ) : (
          <span className="text-muted-foreground">Required before agents can use LiteLLM.</span>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={!canSubmit || saving}>
          {saving ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Settings className="size-3.5" aria-hidden />
          )}
          Save Gateway
        </Button>
      </div>
    </form>
  );
}

export function LiteLLMGatewayStartupDialog() {
  const pathname = usePathname() ?? "";
  const [status, setStatus] = useState<LiteLLMGatewayStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (pathname.startsWith("/login")) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await getLiteLLMGatewayStatus());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [pathname]);

  useEffect(() => {
    void load();
  }, [load]);

  if (pathname.startsWith("/login")) return null;

  const open = Boolean(status && !status.configured);

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>LiteLLM AI Gateway</DialogTitle>
          <DialogDescription>
            Add your gateway connection to finish setup.
          </DialogDescription>
        </DialogHeader>
        {loading && !status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Loading settings
          </div>
        ) : null}
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <LiteLLMGatewayForm
          status={status}
          autoFocus
          onSaved={(next) => setStatus(next)}
        />
      </DialogContent>
    </Dialog>
  );
}
