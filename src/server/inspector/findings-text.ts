// The findings section of every message that hands GitHub Inspector findings to a session.
//
// The workflow `inspector_feedback` packet and Foreman's review follow-through both type
// findings into a pane, and they must say the same thing about the same finding: how severe
// it is, where it is, whether it is on GitHub, and what it says. Each caller keeps its own
// header and closing; this module owns only the findings in between.
//
// Pure, and deliberately so. It imports nothing that opens the database or the network, so
// Foreman's worker (which never touches SQLite) loads it as readily as the daemon does.
// `test/inspector-findings-text.test.ts` walks its import graph to keep it that way.

import type { InspectorComment } from "@shared/types.ts";
import { compareInspectorFindings, findingPublication } from "@shared/inspector-findings.ts";
import { utf8Bytes } from "../util/utf8.ts";
import { clipPacketField, clipUtf8, sanitizeWorkflowFeedback } from "../workflows/packet-text.ts";

export interface RenderedInspectorFindings {
  /** The findings section, already sanitized for a terminal. Empty only when nothing fits. */
  text: string;
  /** Findings listed in `text`. */
  shown: number;
  /** Findings left out to stay under the budget. `shown + omitted` is the deduplicated total. */
  omitted: number;
  /** Some field was clipped mid-text: a field over its cap, or the one finding that had to be. */
  truncated: boolean;
}

export interface RenderInspectorFindingsOptions {
  /** The most UTF-8 bytes `text` may take, closing line included. */
  budgetBytes: number;
}

const BLOCK_SEPARATOR = "\n\n";
const LEGACY_BODY =
  "Legacy finding detail is unavailable. Use the severity, title, and location above.";

/**
 * One finding per fingerprint, in the shared comparator's order.
 *
 * A unique DB index normally makes a duplicate unreachable. Keeping the choice deterministic
 * for a duplicated snapshot stops caller order from changing a frozen packet if a joined or
 * legacy input ever contains the same issue twice.
 */
function dedupeInspectorFindings(findings: readonly InspectorComment[]): InspectorComment[] {
  const stableFinding = (row: InspectorComment): string => JSON.stringify([
    row.path,
    row.line,
    row.title,
    row.body,
    row.severity,
    row.id,
  ]);
  const unique = new Map<string, InspectorComment>();
  for (const finding of findings) {
    const prior = unique.get(finding.fingerprint);
    if (!prior || stableFinding(finding) < stableFinding(prior)) {
      unique.set(finding.fingerprint, finding);
    }
  }
  // The shared comparator, so the findings route lists them in the order these messages do.
  return [...unique.values()].sort(compareInspectorFindings);
}

/**
 * The one line that says whether a finding is on GitHub, and where.
 *
 * A finding the session cannot find on GitHub must say so, or the agent goes looking for a
 * thread that does not exist. And a draft whose earlier version WAS posted must never be
 * called the only copy: the earlier thread is resolved, but it is still where that
 * conversation lives.
 *
 * The link is a packet field like any other, so it clips at the per-field limit. `bound`
 * is the caller's clip, which lets a finding's block record that the link was clipped.
 */
export function inspectorFindingPostedLine(
  finding: InspectorComment,
  bound: (value: string) => string = (value) => clipPacketField(value).value,
): string {
  const publication = findingPublication(finding);
  const url = publication.url ? bound(publication.url) : null;
  switch (publication.state) {
    case "posted":
      if (!url) return "Posted on GitHub (link not captured yet)";
      // A finding with no line was demoted into the review body; its link is that review.
      return finding.line === null
        ? `Posted on GitHub in the review summary: ${url}`
        : `Posted on GitHub: ${url}`;
    case "not-posted":
      if (publication.earlierPost) {
        return url
          ? `Not posted again. An earlier version was posted on GitHub: ${url}`
          : "Not posted again. An earlier version was posted on GitHub (link not captured).";
      }
      return "Not posted on GitHub. This message is the only copy.";
    case "posting":
      return "Being posted now";
    case "unknown":
      return "Not known whether this was posted on GitHub: it was recorded before Mission Control tracked posting.";
    default: {
      const unreachable: never = publication.state;
      return unreachable;
    }
  }
}

/**
 * The closing line for findings left out. Kept to the relay's own promise: an omitted
 * finding is still unresolved, so the next message carries it again.
 */
export function omittedFindingsLine(omitted: number): string {
  return omitted === 1
    ? "1 more unresolved finding is not listed here, to keep this message short. It stays open and comes back in the next relay."
    : `${omitted} more unresolved findings are not listed here, to keep this message short. They stay open and come back in the next relay.`;
}

/**
 * Render the findings section under a byte budget.
 *
 * Fields clip at `feedbackFieldBytes`, as every packet field does. Past the budget, whole
 * findings drop from the tail - the tail is the lowest severity, by the comparator - and a
 * closing line says how many. A finding is never cut part way to make room for another.
 *
 * The one exception is the first finding when even it does not fit beside the closing line:
 * a message that lists no finding at all gives the session nothing to act on, so the
 * highest-severity finding is kept and its body shortened (or, failing that, the finding
 * itself), and `truncated` says so.
 */
export function renderInspectorFindings(
  findings: readonly InspectorComment[],
  opts: RenderInspectorFindingsOptions,
): RenderedInspectorFindings {
  const budget = Math.max(0, Math.floor(opts.budgetBytes));
  const blocks = dedupeInspectorFindings(findings).map(renderBlock);
  const total = blocks.length;
  if (total === 0) return { text: "", shown: 0, omitted: 0, truncated: false };

  const fit = wholeFindingsThatFit(blocks, budget);
  if (fit > 0) {
    const kept = blocks.slice(0, fit);
    return {
      text: joinSection(kept.map((block) => block.text), total - fit),
      shown: fit,
      omitted: total - fit,
      truncated: kept.some((block) => block.truncated),
    };
  }

  const omitted = total - 1;
  const closing = omitted > 0 ? BLOCK_SEPARATOR + omittedFindingsLine(omitted) : "";
  const first = shrinkBlock(blocks[0]!, budget - utf8Bytes(closing));
  if (first) {
    return { text: `${first}${closing}`, shown: 1, omitted, truncated: true };
  }
  const line = omittedFindingsLine(total);
  return {
    text: utf8Bytes(line) <= budget ? line : "",
    shown: 0,
    omitted: total,
    truncated: true,
  };
}

/** How many leading findings fit whole, beside the omitted-count line the rest would need. */
function wholeFindingsThatFit(blocks: readonly FindingBlock[], budget: number): number {
  let used = 0;
  let fit = 0;
  for (let shown = 1; shown <= blocks.length; shown += 1) {
    used += utf8Bytes(blocks[shown - 1]!.text) + (shown > 1 ? BLOCK_SEPARATOR.length : 0);
    if (used > budget) break;
    const omitted = blocks.length - shown;
    const closing = omitted > 0 ? BLOCK_SEPARATOR.length + utf8Bytes(omittedFindingsLine(omitted)) : 0;
    if (used + closing <= budget) fit = shown;
  }
  return fit;
}

interface FindingBlock {
  /** Severity, title, location and posted lines. */
  head: string;
  body: string;
  /** The fingerprint line. */
  tail: string;
  text: string;
  truncated: boolean;
}

function renderBlock(finding: InspectorComment): FindingBlock {
  let truncated = false;
  const bounded = (value: string): string => {
    const result = clipPacketField(value);
    truncated ||= result.truncated;
    return result.value;
  };
  const location = finding.path
    ? `${finding.path}${finding.line ? `:${finding.line}` : ""}`
    : "general";
  const head = sanitizeWorkflowFeedback([
    `## ${finding.severity.toUpperCase()} - ${bounded(finding.title)}`,
    `Location: ${bounded(location)}`,
    inspectorFindingPostedLine(finding, bounded),
  ].join("\n"));
  const body = bounded(finding.body ?? LEGACY_BODY);
  const tail = sanitizeWorkflowFeedback(`Fingerprint: ${finding.fingerprint}`);
  return { head, body, tail, text: `${head}\n${body}\n${tail}`, truncated };
}

/** The first finding cut to `room` bytes: its body first, the whole finding only if it must. */
function shrinkBlock(block: FindingBlock, room: number): string | null {
  if (room <= 0) return null;
  const bodyRoom = room - utf8Bytes(`${block.head}\n\n${block.tail}`);
  if (bodyRoom > 0) {
    return `${block.head}\n${clipUtf8(block.body, bodyRoom).value}\n${block.tail}`;
  }
  const clipped = clipUtf8(block.text, room).value.replace(/\s+$/u, "");
  return clipped || null;
}

function joinSection(blocks: string[], omitted: number): string {
  return [...blocks, ...(omitted > 0 ? [omittedFindingsLine(omitted)] : [])].join(BLOCK_SEPARATOR);
}
