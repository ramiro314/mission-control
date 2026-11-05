import type { WorkflowNodeAttempt } from "@shared/workflow.ts";
import {
  countedChecks,
  quotedNames,
  waitForCiSettings,
  waitForCiTruncated,
  type CiCheckRun,
  type WaitForCiSettings,
} from "@shared/wait-for-ci.ts";
import { ClockText } from "../components/ClockText.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import {
  waitForCiHeadline,
  waitForCiSettingsLine,
  waitForCiStateOf,
  waitForCiTruncationNote,
} from "./run-model.ts";

const CHECK_STATE_WORDS: Record<CiCheckRun["state"], string> = {
  pending: "Running",
  passing: "Passed",
  failing: "Failed",
};

/**
 * Why a check does or does not count, in Required mode only. "Not required" is said only once
 * GitHub has marked some check required: with none marked, every check counts.
 */
function checkTag(run: CiCheckRun, settings: WaitForCiSettings, anyMarked: boolean): string | null {
  if (settings.strictness !== "required") return null;
  if (run.required === true) return "Required";
  if (settings.expectedChecks.includes(run.name)) return "Expected";
  return anyMarked ? "Not required" : null;
}

/**
 * What a Wait for CI attempt is waiting for, or what it decided: the pull request and head,
 * the settings it judges under, each check with its state (tagged in Required mode, with a row
 * for each expected check not reported yet), the counted failing checks on a fail, the flakes on
 * a pass when CI published a flake report, and the block sentence when it blocked. Renders
 * nothing for any other
 * attempt, so the attempt and verdict cards can include it unconditionally.
 */
export function WaitForCiPanel({
  attempt,
  now,
}: {
  attempt: Pick<WorkflowNodeAttempt, "output">;
  now?: number;
}): React.JSX.Element | null {
  const state = waitForCiStateOf(attempt);
  if (!state) return null;
  const settings = waitForCiSettings(state);
  // The panel lists only what the node counted, so a failure that is not required never reads
  // as the reason it failed.
  const failing = countedChecks(state.checkRuns, settings).counted.filter((run) => run.state === "failing");
  const anyMarked = state.checkRuns.some((run) => run.required === true);
  const unreported = state.observedAt === null ? [] : (state.missingExpected ?? []);
  const flakes = state.flakeReport?.flakes ?? [];
  const issues = new Map((state.flakeReport?.issues ?? []).map((issue) => [issue.key, issue]));
  return (
    <section className="wf-run-ci" aria-label="Wait for CI">
      <p className="wf-run-ci-headline">
        {now === undefined
          ? <ClockText read={(at) => waitForCiHeadline(state, at)} />
          : waitForCiHeadline(state, now)}
      </p>
      {state.pullRequestUrl && (
        <p className="wf-run-meta">
          <Tooltip label="Open the pull request on GitHub">
            <a href={state.pullRequestUrl} target="_blank" rel="noreferrer">
              {state.pullRequestKey ?? state.pullRequestUrl}
            </a>
          </Tooltip>
          {state.expectedHeadOid ? ` · head ${state.expectedHeadOid.slice(0, 12)}` : ""}
        </p>
      )}
      <p className="wf-run-meta">{waitForCiSettingsLine(state)}</p>
      {state.requiredFallback && (
        <p className="wf-run-meta">No check on this head is marked required, so every check was judged.</p>
      )}
      {waitForCiTruncated(state) && <p className="wf-run-meta">{waitForCiTruncationNote(state)}</p>}
      {state.outcome === "fail" && failing.length > 0 && (
        <>
          <h5>Failing checks</h5>
          <ul className="wf-run-ci-failing">
            {failing.map((run, index) => (
              <li key={`${index}:${run.name}`}>
                <strong>{run.name}</strong>
                {run.conclusion ? ` · ${run.conclusion.toLowerCase()}` : ""}
                {run.title ? ` · ${run.title}` : ""}
                {run.detailsUrl && (
                  <>
                    {" · "}
                    <Tooltip label={`Open ${run.name} on GitHub`}>
                      <a href={run.detailsUrl} target="_blank" rel="noreferrer">details</a>
                    </Tooltip>
                  </>
                )}
              </li>
            ))}
          </ul>
          {unreported.length > 0 && (
            <p className="wf-run-meta">{`Not reported when CI failed: ${quotedNames(unreported)}.`}</p>
          )}
        </>
      )}
      {state.outcome === "pass" && state.flakeReport && (
        <p className="wf-run-meta">
          {flakes.length === 0
            ? "No flaky tests in this run."
            : `${flakes.length} flaky test${flakes.length === 1 ? "" : "s"} failed, then passed on rerun:`}
        </p>
      )}
      {state.outcome === "pass" && flakes.length > 0 && (
        <ul className="wf-run-ci-flakes" aria-label="Flaky tests">
          {flakes.map((flake) => {
            const issue = issues.get(flake.key);
            return (
              <li key={flake.key}>
                <strong>{flake.name}</strong> · <code>{flake.file}</code>
                {issue && (
                  <>
                    {" · "}
                    <Tooltip label="Open this test's flake history issue">
                      <a href={issue.url} target="_blank" rel="noreferrer">#{issue.number}</a>
                    </Tooltip>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(state.checkRuns.length > 0 || unreported.length > 0) && (
        <details open={state.outcome === null}>
          <Tooltip label="Show every check GitHub reported on the head commit">
            <summary>{`Checks on the head commit (${state.checkRuns.length})`}</summary>
          </Tooltip>
          <ul className="wf-run-ci-checks" aria-label="CI checks">
            {state.checkRuns.map((run, index) => {
              const tag = checkTag(run, settings, anyMarked);
              return (
                <li key={`${index}:${run.name}`} className={`is-${run.state}`}>
                  <span>{run.name}</span>
                  {tag && <> <span className="wf-run-ci-tag">{tag}</span></>}
                  {" "}<span className="wf-run-meta">{CHECK_STATE_WORDS[run.state]}</span>
                </li>
              );
            })}
            {unreported.map((name) => (
              <li key={`expected:${name}`} className="is-pending">
                <span>{name}</span> <span className="wf-run-ci-tag">Expected</span>
                {" "}<span className="wf-run-meta">Not reported yet</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {state.outcome === null && state.checkRuns.length === 0 && unreported.length === 0 && (
        <p className="wf-run-meta">
          {state.observedAt === null
            ? "GitHub Inspector has not read CI for this head yet."
            : "No CI check has appeared on this head yet."}
        </p>
      )}
    </section>
  );
}
