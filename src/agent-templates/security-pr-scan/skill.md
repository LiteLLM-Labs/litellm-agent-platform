---
name: reviewing-security
description: Scans a GitHub pull request for security vulnerabilities including OWASP Top 10 issues, hardcoded secrets, and dependency CVEs. Returns a structured JSON findings report. Use when asked to review, audit, or scan a PR for security issues.
---

## PR security scan

Copy this checklist and track progress:

```
- [ ] 1. Fetch PR diff
- [ ] 2. Secrets scan
- [ ] 3. SAST scan
- [ ] 4. Dependency audit (if lockfile changed)
- [ ] 5. Auth/authz regression check
- [ ] 6. Output findings
```

### Step 1 — Fetch diff

```bash
gh pr diff <PR_URL>
```

### Step 2 — Secrets scan

```bash
gitleaks detect --source . --no-git 2>/dev/null; gitleaks_exit=$?; [ $gitleaks_exit -eq 2 ] && echo "gitleaks not available, scanning manually"
```

Note: exit code 1 means findings were detected (expected); exit code 2 means gitleaks could not run.

Flag: API keys, tokens, passwords, PII in changed lines.

### Step 3 — SAST scan

```bash
semgrep --config=auto --quiet 2>/dev/null; semgrep_exit=$?; [ $semgrep_exit -ge 2 ] && echo "semgrep not available"
```

Note: exit code 1 means findings were detected (expected); exit code 2+ means semgrep could not run.

Focus: injection (SQL/cmd/XSS), broken access control, insecure deserialization, crypto misuse.

### Step 4 — Dependency audit

Only if `package.json`, `requirements.txt`, `go.mod`, or lockfiles changed:

```bash
npm audit --json 2>/dev/null || pip-audit 2>/dev/null || govulncheck ./... 2>/dev/null
```

### Step 5 — Auth/authz regression

Grep for changes to middleware, permission checks, session handling. Flag removed or weakened guards.

### Step 6 — Output

```json
{
  "summary": "<N> critical, <N> high, <N> medium",
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "type": "secret|injection|auth|dependency|other",
      "file": "path/to/file.ts",
      "line": 14,
      "description": "Specific issue description."
    }
  ],
  "recommendation": "Block merge / Merge with caveats / Safe to merge"
}
```

**Rules:** Never approve or merge. Report only. If no issues found, state explicitly with confidence level.
