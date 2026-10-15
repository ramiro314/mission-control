import { Fragment, useState } from "react";
import type { InspectorComment, InspectorCommentStatus, InspectorSeverity } from "@shared/types.ts";
import { findingPublication } from "@shared/inspector-findings.ts";
import type { PipelineStatus } from "../workflows/pipeline-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * GitHub Inspector's findings on one pull request, as one table.
 *
 * Every reader of a pull request's findings draws this table: the workflow run record's
 * Completion tab and the Settings Findings modal. Each caller keeps its own caption and its own
 * empty state, because "no findings" means different things on a gate and in a modal; the
 * columns, the chips, the Posted cell and the body rule are this file's and nobody else's.
 */

/**
 * A finding's severity as a chip, on the tone mapping the finding CARD already used.
 *
 * The card split blocker and major (a danger edge) from minor and nit (an attention one). The
 * table keeps exactly that split rather than inventing a four-tone scale: the severity word
 * itself is on the chip, so the colour only has to say which half it is in.
 */
export function inspectorFindingSeverityStatus(severity: InspectorSeverity): PipelineStatus {
  return severity === "blocker" || severity === "major"
    ? { tone: "failed", label: severity }
    : { tone: "waiting", label: severity };
}

/** A finding's status as a chip. Only `resolved` is a finished fact. */
export function inspectorFindingStatusStatus(status: InspectorCommentStatus): PipelineStatus {
  if (status === "resolved") return { tone: "passed", label: status };
  return status === "posting"
    ? { tone: "waiting", label: status }
    : { tone: "failed", label: status };
}

/** Where a finding is, as the table prints it. `general` for a finding with no path. */
export function inspectorFindingLocation(finding: InspectorComment): string {
  if (!finding.path) return "general";
  return finding.line ? `${finding.path}:${finding.line}` : finding.path;
}

/**
 * A finding whose detail predates body persistence, said once.
 *
 * The card printed this sentence in place of the body; the row keeps it rather than drawing an
 * empty panel, because "this build has no body for this row" and "this finding had nothing to
 * say" are different claims and only one of them is true.
 */
const LEGACY_FINDING_SENTENCE =
  "Legacy finding: detail was not persisted by the GitHub Inspector version that created this row.";

/** What a finding's row prints as its body, legacy arm included. */
export function inspectorFindingBody(finding: InspectorComment): string {
  return finding.body ?? LEGACY_FINDING_SENTENCE;
}

/** The tooltip on a finding recorded before posting was tracked. */
export const UNKNOWN_POSTED_TOOLTIP = "Recorded before Mission Control tracked posting";

/** What the Posted cell says, where it links, and what its tooltip adds. */
export interface InspectorFindingPostedCell {
  label: string;
  /** The GitHub comment the label links to, or null for plain text. */
  href: string | null;
  tooltip: string | null;
}

/**
 * The Posted cell, read off `findingPublication` and nothing else.
 *
 * The switch is exhaustive over the publication state, so a state the derivation gains later
 * fails the build here rather than printing a blank cell. A posted finding without a captured
 * link still reads "Posted": the Inspector records the link on a later pass, and until then
 * the claim that it reached GitHub is true and the link is simply not known yet.
 */
export function inspectorFindingPostedCell(finding: InspectorComment): InspectorFindingPostedCell {
  const publication = findingPublication(finding);
  switch (publication.state) {
    case "posted":
      return publication.url
        ? { label: "Posted", href: publication.url, tooltip: "Open this finding on GitHub" }
        : {
          label: "Posted",
          href: null,
          tooltip: "Posted on GitHub. The link is recorded on GitHub Inspector's next pass",
        };
    case "not-posted":
      if (publication.earlierPost) {
        return {
          label: "Not posted (posted earlier)",
          href: publication.url,
          tooltip: publication.url
            ? "Not posted again. Open the earlier version on GitHub"
            : "Not posted again. An earlier version was posted on GitHub",
        };
      }
      return { label: "Not posted", href: null, tooltip: null };
    case "posting":
      return { label: "Posting", href: null, tooltip: null };
    case "unknown":
      return { label: "Unknown", href: null, tooltip: UNKNOWN_POSTED_TOOLTIP };
    default: {
      const exhaustive: never = publication.state;
      return exhaustive;
    }
  }
}

function PostedCell({ finding }: { finding: InspectorComment }): React.JSX.Element {
  const cell = inspectorFindingPostedCell(finding);
  if (cell.href) {
    return (
      <Tooltip label={cell.tooltip ?? "Open on GitHub"}>
        <a href={cell.href} target="_blank" rel="noreferrer">{cell.label}</a>
      </Tooltip>
    );
  }
  return cell.tooltip
    ? <Tooltip label={cell.tooltip}><span>{cell.label}</span></Tooltip>
    : <span>{cell.label}</span>;
}

const COLUMNS = ["Severity", "Finding", "Where", "Round", "Status", "Posted", "Detail"] as const;

function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function InspectorFindingsTable({
  findings,
  caption,
}: {
  findings: readonly InspectorComment[];
  /** The screen-reader caption, which says whose findings these are. */
  caption: string;
}): React.JSX.Element {
  const [openFinding, setOpenFinding] = useState<string | null>(null);
  return (
    <div className="wf-run-table wf-run-ledger">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {COLUMNS.map((column) => <th key={column}>{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {findings.map((finding) => {
            const severity = inspectorFindingSeverityStatus(finding.severity);
            const status = inspectorFindingStatusStatus(finding.status);
            const open = openFinding === finding.id;
            // An UNRESOLVED finding is why the gate has not passed, so its body is never
            // behind a disclosure - the same rule the delivery ledger applies to a refused
            // packet, and for the same reason: a reader should not have to go looking for the
            // thing that stopped the run.
            const unresolved = finding.status !== "resolved";
            return (
              <Fragment key={finding.id}>
                <tr className={`wf-run-ledger-row wf-run-finding-row is-${finding.severity}`}>
                  <td>
                    <span className={`workflow-chip workflow-${severity.tone}`}>
                      {severity.label}
                    </span>
                  </td>
                  <td>{finding.title}</td>
                  <td><code>{inspectorFindingLocation(finding)}</code></td>
                  <td>{finding.round}</td>
                  <td>
                    <span className={`workflow-chip workflow-${status.tone}`}>
                      {status.label}
                    </span>
                  </td>
                  <td><PostedCell finding={finding} /></td>
                  <td>
                    <Tooltip label={open
                      ? "Hide this finding's fingerprint and its timestamps"
                      : "Show the fingerprint the gate tracks this finding by, and when it moved"}>
                      <button
                        className="btn btn-ghost wf-run-ledger-toggle"
                        aria-expanded={open}
                        aria-controls={`wf-run-finding-${finding.id}`}
                        onClick={() => setOpenFinding(open ? null : finding.id)}
                      >
                        {open ? "Hide finding" : "Show finding"}
                      </button>
                    </Tooltip>
                  </td>
                </tr>
                {unresolved && (
                  <tr className="wf-run-ledger-alert">
                    <td colSpan={COLUMNS.length}>
                      <p className="wf-run-sentence">{inspectorFindingBody(finding)}</p>
                    </td>
                  </tr>
                )}
                {open && (
                  <tr className="wf-run-ledger-detail" id={`wf-run-finding-${finding.id}`}>
                    <td colSpan={COLUMNS.length}>
                      {/* A resolved finding's body opens here; an unresolved one is already
                          printed above rather than twice. */}
                      {!unresolved && <p>{inspectorFindingBody(finding)}</p>}
                      <dl className="wf-run-facts-list">
                        <div><dt>Fingerprint</dt><dd><code>{finding.fingerprint}</code></dd></div>
                        <div><dt>Recorded</dt><dd>{when(finding.createdAt)}</dd></div>
                        <div><dt>Last change</dt><dd>{when(finding.updatedAt)}</dd></div>
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
