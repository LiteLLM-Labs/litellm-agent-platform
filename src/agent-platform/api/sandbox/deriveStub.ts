/**
 * Derives a deterministic stub name for an agent credential.
 *
 * Both the web worker (E2bProvider) and the cloud-vault independently derive
 * the same stub using this formula — no registration or coordination needed.
 * The stub is safe to expose in sandbox env: it's meaningless without the
 * cloud-vault proxy (which requires Proxy-Authorization).
 *
 * Formula: stub_<agentId>_<keyName_lowercased_underscored>
 * Example: deriveStub("clx123", "GITHUB_TOKEN") → "stub_clx123_github_token"
 */
export function deriveStub(agentId: string, keyName: string): string {
  return `stub_${agentId}_${keyName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}
