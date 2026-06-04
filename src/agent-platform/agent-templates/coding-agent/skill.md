---
name: coding-agent
description: Standard procedures for a coding agent — memory hygiene and PR workflow.
---

## Memory hygiene

Before starting any task, search for relevant prior context:
```
search_memory("relevant keywords for the task")
```

After completing significant work, save non-obvious findings:
```
save_memory({ content: "...", tags: ["relevant-area"] })
```

## PR workflow

1. Create a branch: `git checkout -b <descriptive-name>`
2. Make changes, commit: `git add -A && git commit -m "..."`
3. Push: `git push -u origin HEAD`
4. Open PR: `gh pr create --title "..." --body "..."`
