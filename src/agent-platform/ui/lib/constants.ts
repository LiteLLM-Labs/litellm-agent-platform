export const PROJECTS_STORAGE_KEY = "lap_custom_templates";
export const SANDBOX_TEMPLATES_STORAGE_KEY = PROJECTS_STORAGE_KEY;
export const BRAIN_INLINE_HARNESS_ID = "claude-code-brain-inline";
export const OPENCODE_BRAIN_INLINE_HARNESS_ID = "opencode-brain-inline";

export const PROJECT_REQUIRED_HARNESS_IDS = new Set([
  BRAIN_INLINE_HARNESS_ID,
  OPENCODE_BRAIN_INLINE_HARNESS_ID,
]);
