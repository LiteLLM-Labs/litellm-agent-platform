-- Per-credential egress binding for managed agents: maps each env var key to
-- the host(s) the vault may swap its real value into. Default '{}' = unbound.
ALTER TABLE "managed_agent" ADD COLUMN "env_var_hosts" JSONB NOT NULL DEFAULT '{}';
