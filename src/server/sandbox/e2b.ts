import { Sandbox } from "e2b";

import { SandboxProvider, type ProvisionParams } from "./provider";

export class E2bProvider extends SandboxProvider {
  readonly urlScheme = "e2b";

  constructor(
    private readonly apiKey: string,
    private readonly template: string,
  ) {
    super();
  }

  async create(_params: ProvisionParams): Promise<string> {
    // 24h timeout — max for Pro; prevents sandbox expiring mid-session.
    const sandbox = await Sandbox.create(this.template, {
      apiKey: this.apiKey,
      timeoutMs: 24 * 60 * 60 * 1000,
    });
    return sandbox.sandboxId;
  }

  async execute(id: string, cmd: string, timeoutMs: number): Promise<string> {
    try {
      const sandbox = await Sandbox.connect(id, { apiKey: this.apiKey });
      const result = await sandbox.commands.run(cmd, { timeoutMs });
      return (result.stdout ?? "") + (result.stderr ?? "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Sandbox expired or was killed — tell the agent to re-provision.
      if (msg.includes("404") || msg.includes("terminated") || msg.includes("doesn't exist")) {
        return `error: sandbox expired — call provision to create a new one (${msg})`;
      }
      throw err;
    }
  }

  async terminate(id: string): Promise<void> {
    await Sandbox.kill(id, { apiKey: this.apiKey });
  }
}
