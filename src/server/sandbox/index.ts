import { env } from "@/server/env";

import { DaytonaProvider } from "./daytona";
import { E2bProvider } from "./e2b";
import { SandboxProvider } from "./provider";

export { SandboxProvider } from "./provider";

function buildRegistry(): Record<string, SandboxProvider> {
  return {
    e2b: new E2bProvider(env.E2B_API_KEY ?? "", env.E2B_TEMPLATE),
    daytona: new DaytonaProvider(
      env.DAYTONA_API_KEY ?? "",
      env.DAYTONA_API_URL,
      env.DAYTONA_SNAPSHOT,
      env.DAYTONA_IMAGE,
    ),
  };
}

let _registry: Record<string, SandboxProvider> | null = null;

export function getRegistry(): Record<string, SandboxProvider> {
  if (!_registry) _registry = buildRegistry();
  return _registry;
}
