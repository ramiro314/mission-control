import { foldHistorySearch } from "@shared/history.ts";

/**
 * The text History's search scans, built on `archive_search_segments`' rules: bounded
 * segments of folded text, and long text split into chunks that overlap, so a phrase across
 * a chunk boundary is still found. What a session's segments say is the reconciler's policy;
 * how they are cut is this file's.
 */

/** The most characters one segment holds. */
const SEGMENT_CHARS = 4_000;
/** How far consecutive chunks of one prompt overlap: the longest query, so none straddles. */
const SEGMENT_OVERLAP = 200;
/**
 * The most of one prompt that is indexed. A conversation's prompts are indexed in full up to
 * this; past it is a pasted log or diff, which is not what anyone searches History for.
 */
const PROMPT_CHARS = 16_000;
/** Between fields in the fields segment. Never typed, and never produced by the fold. */
const FIELD_SEPARATOR = "\u001f";

/** The fields segment (ordinal 0): title fields, cwd, repository and branch. */
export function historyFieldsSegment(fields: {
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  cwd: string | null;
  repoRoot: string | null;
  branch: string | null;
}): string {
  return [fields.customTitle, fields.aiTitle, fields.firstPrompt, fields.cwd, fields.repoRoot, fields.branch]
    .map((field) => (field ? foldHistorySearch(field) : ""))
    .filter((field) => field !== "")
    .join(FIELD_SEPARATOR);
}

/** Prompt segments, in order: each prompt folded, capped and cut into overlapping chunks. */
export function historyPromptSegments(prompts: readonly string[]): string[] {
  const out: string[] = [];
  const stride = SEGMENT_CHARS - SEGMENT_OVERLAP;
  for (const prompt of prompts) {
    const text = foldHistorySearch(prompt).slice(0, PROMPT_CHARS);
    for (let start = 0; start < text.length; start += stride) {
      out.push(text.slice(start, start + SEGMENT_CHARS));
      if (start + SEGMENT_CHARS >= text.length) break;
    }
  }
  return out;
}

/** The query as segments are matched against it, or null when it asks for nothing. */
export function historySearchNeedle(raw: string | undefined): string | null {
  const needle = raw ? foldHistorySearch(raw) : "";
  return needle === "" ? null : needle;
}
