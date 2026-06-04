"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/components/ui/card";
import { Textarea } from "@/ui/components/ui/textarea";
import { Input } from "@/ui/components/ui/input";
import { Label } from "@/ui/components/ui/label";
import {
  AgentRow,
  ApiError,
  listAgents,
  spawnSession,
} from "@/ui/lib/api";

const TITLE_MAX = 64;

export default function NewSessionPage() {
  const router = useRouter();

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    setAgentsError(null);
    try {
      const res = await listAgents();
      setAgents(res);
      if (res.length > 0) {
        setAgentId((current) => current || res[0].id);
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setAgentsError(msg);
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  function validate(): string | null {
    if (!agentId) return "Agent is required.";
    if (title.trim().length > TITLE_MAX) {
      return `Title must be ${TITLE_MAX} characters or fewer.`;
    }
    return null;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      const created = await spawnSession(agentId, {
        title: title.trim() || undefined,
        initial_prompt: initialPrompt.trim() || undefined,
      });
      if (created.warnings?.length) {
        sessionStorage.setItem(`session-warnings:${created.id}`, JSON.stringify(created.warnings));
      }
      router.push(`/sessions/${created.id}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-[22px] font-semibold tracking-tight">New Session</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick an agent and (optionally) seed it with an opening prompt. The
        proxy will provision a fresh Fargate task — typically 50–90 seconds.
      </p>

      <Card className="mt-6">
        <CardHeader className="sr-only">
          <CardTitle>New Session</CardTitle>
          <CardDescription>
            Spawn a session against an agent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={onSubmit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="agent">Agent</Label>
              <select
                id="agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                disabled={submitting || agentsLoading}
                required
                className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
              >
                {agentsLoading ? (
                  <option value="">Loading…</option>
                ) : agents.length === 0 ? (
                  <option value="">No agents found — create one first</option>
                ) : (
                  <>
                    <option value="" disabled>
                      Select an agent…
                    </option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name?.trim() || a.id}
                      </option>
                    ))}
                  </>
                )}
              </select>
              {agentsError ? (
                <p className="font-mono text-xs text-destructive">
                  {agentsError}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="title">Title (optional)</Label>
              <Input
                id="title"
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="ad-hoc smoke run"
                disabled={submitting}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="initial-prompt">Initial prompt (optional)</Label>
              <Textarea
                id="initial-prompt"
                value={initialPrompt}
                onChange={(e) => setInitialPrompt(e.target.value)}
                placeholder="In one sentence, what is this repo?"
                rows={6}
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground">
                If set, the harness runs this prompt once the sandbox is ready.
                The first response is included in the spawn result.
              </p>
            </div>

            <div className="pt-2">
              <Button
                type="submit"
                disabled={submitting || agentsLoading || agents.length === 0}
              >
                {submitting ? "Provisioning… (~60s)" : "Spawn session"}
              </Button>
              {error ? (
                <p className="mt-3 font-mono text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
