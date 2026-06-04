/**
 * Markdown -> Slack "mrkdwn" converter.
 *
 * Slack's chat.postMessage `text` field uses its own pseudo-markdown ("mrkdwn"),
 * not CommonMark. The agent generates standard Markdown, so we translate the
 * bits that differ before posting:
 *
 *   `## Heading`        -> `*Heading*`            (Slack has no header syntax)
 *   `**bold**`          -> `*bold*`               (Slack bold is single `*`)
 *   `*italic*`          -> `_italic_`             (single `*` is bold in Slack)
 *   `~~strike~~`        -> `~strike~`
 *   `[text](url)`       -> `<url|text>`           (Slack link syntax)
 *   `- item`/`* item`   -> `• item`               (Slack has no list rendering)
 *
 * Code fences and inline backticks render correctly in Slack already, so we
 * pull them out before transforming and splice them back in unchanged — that
 * way we never mangle `**stars**` or `# hashes` that live inside code samples.
 *
 * The language tag on a fenced block (` ```python `) is stripped because Slack
 * shows it as a literal first line.
 */

// Sentinel chars used while transforming bold so we don't clash with the
// italic pass (markdown italic is `*X*` and Slack bold is also `*X*`).
const BOLD_OPEN = "";
const BOLD_CLOSE = "";

/** Strip an optional language hint off the opening fence. */
function stripFenceLang(fence: string): string {
  return fence.replace(/^```[a-zA-Z0-9_+\-.]*[ \t]*\n/, "```\n");
}

/** Transform a chunk of prose (no fenced blocks, no inline code). */
function transformInline(text: string): string {
  let out = text;

  // Markdown links `[label](url)` -> Slack `<url|label>`. Drops any
  // `"title"` after the URL since Slack has nowhere to surface it.
  out = out.replace(
    /\[([^\]\n]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
    "<$2|$1>",
  );

  // ATX headers on their own line -> bold. Trailing `#` chars (optional in
  // CommonMark) are stripped. Park inside the bold sentinels so the italic
  // pass below doesn't see `*Header*` and flip it to `_Header_`.
  out = out.replace(
    /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,
    `${BOLD_OPEN}$1${BOLD_CLOSE}`,
  );

  // Bold-italic `***X***` -> `*_X_*` (parked behind sentinels for the bold
  // pass; the inner `_X_` stays as-is).
  out = out.replace(
    /\*\*\*([^*\n]+?)\*\*\*/g,
    `${BOLD_OPEN}_$1_${BOLD_CLOSE}`,
  );

  // Bold `**X**` -> sentinel-wrapped; we replace with `*` after the italic
  // pass runs, otherwise the italic regex would see the unwrapped `*X*` and
  // mangle it.
  out = out.replace(
    /\*\*([^*\n]+?)\*\*/g,
    `${BOLD_OPEN}$1${BOLD_CLOSE}`,
  );

  // Italic `*X*` -> `_X_`. Requires the `*` to be at a word boundary on the
  // outside so we don't grab stray asterisks (e.g. `a*b*c` or `* bullet`).
  out = out.replace(
    /(^|[^\w*])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?!\w)/g,
    "$1_$2_",
  );

  // Restore the bold sentinels as Slack `*`.
  out = out.replace(new RegExp(BOLD_OPEN, "g"), "*");
  out = out.replace(new RegExp(BOLD_CLOSE, "g"), "*");

  // Strikethrough `~~X~~` -> `~X~`.
  out = out.replace(/~~([^~\n]+?)~~/g, "~$1~");

  // Unordered list markers at line start -> bullet glyph. Runs after the
  // bold/italic passes so `* item` isn't misread as italic (it can't be,
  // since italic needs a matching close `*` on the same line, but order it
  // safely anyway).
  out = out.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");

  return out;
}

/**
 * Convert a Markdown string to Slack mrkdwn. Code fences and inline code
 * are preserved verbatim (apart from stripping the language tag).
 */
export function mrkdwnFromMarkdown(input: string): string {
  if (!input) return input;

  // Phase 1: pull fenced code blocks out so their contents aren't
  // transformed. We re-emit them with the language tag stripped.
  const parts: string[] = [];
  const fenceRe = /```[^\n]*\n[\s\S]*?```/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(input)) !== null) {
    parts.push(transformOutsideFences(input.slice(cursor, m.index)));
    parts.push(stripFenceLang(m[0]));
    cursor = m.index + m[0].length;
  }
  parts.push(transformOutsideFences(input.slice(cursor)));
  return parts.join("");
}

/**
 * Apply inline transforms to text that's already known to be outside any
 * fenced code block, treating spans of inline code (`` `...` ``) as opaque.
 */
function transformOutsideFences(text: string): string {
  const parts: string[] = [];
  const inlineRe = /`[^`\n]+`/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(text)) !== null) {
    parts.push(transformInline(text.slice(cursor, m.index)));
    parts.push(m[0]);
    cursor = m.index + m[0].length;
  }
  parts.push(transformInline(text.slice(cursor)));
  return parts.join("");
}
