/**
 * Linear issue → harness prompt.
 *
 * Linear's webhook payload carries the issue + optional @mention comment.
 * We synthesize a single prompt string that the harness can act on.
 *
 * Kept tiny on purpose — once we want richer context (sub-issues, attachments,
 * cycle metadata, etc.), this is where the GraphQL hydration would land.
 */

interface IssueLike {
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
}

interface CommentLike {
  body?: string | null;
}

interface CreatorLike {
  name?: string | null;
}

interface AgentSessionLike {
  issue?: IssueLike | null;
  comment?: CommentLike | null;
  creator?: CreatorLike | null;
}

export function issueToPrompt(session: AgentSessionLike): string {
  const issue = session.issue ?? {};
  const lines: string[] = [];

  const heading = [issue.identifier, issue.title].filter(Boolean).join(": ");
  if (heading) lines.push(`Linear issue ${heading}`);
  if (issue.url) lines.push(issue.url);
  if (lines.length > 0) lines.push("");

  if (issue.description) lines.push(issue.description);

  const comment = session.comment?.body?.trim();
  if (comment) {
    const author = session.creator?.name ?? "the user";
    lines.push("", `@-mention from ${author}:`, comment);
  }

  return lines.join("\n").trim();
}
