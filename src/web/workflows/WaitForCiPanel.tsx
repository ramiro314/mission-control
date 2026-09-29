import type { WorkflowNodeAttempt } from "@shared/workflow.ts";
import type { CiCheckRun } from "@shared/wait-for-ci.ts";
import { FLAKY_TESTS_CHECK_NAME } from "@shared/flake-report.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { waitForCiHeadline, waitForCiStateOf } from "./run-model.ts";

const CHECK_STATE_WORDS: Record<CiCheckRun["state"], string> = {
  pending: "Running",
  passing: "Passed",
  failing: "Failed",
};

/**
 * What a Wait for CI attempt is waiting for, or what it decided: the pull request and head,
 * elapsed time against the limit, each check with its state, the failing checks on a fail,
 * the flakes on a pass, and the block sentence when it blocked. Renders nothing for any other
 * attempt, so the attempt and verdict cards can include it unconditionally.
 */
export function WaitForCiPanel({
  attempt,
  now = Date.now(),
}: {
  attempt: Pick<WorkflowNodeAttempt, "output">;
  now?: number;
}): React.JSX.Element | null {
  const state = waitForCiStateOf(attempt);
  if (!state) return null;
  const failing = state.checkRuns.filter((run) =>
    run.state === "failing" && run.name !== FLAKY_TESTS_CHECK_NAME);
  const flakes = state.flakeReport?.flakes ?? [];
  const issues = new Map((state.flakeReport?.issues ?? []).map((issue) => [issue.key, issue]));
  return (
    <section className="wf-run-ci" aria-label="Wait for CI">
      <p className="wf-run-ci-headline">{waitForCiHeadline(state, now)}</p>
      {state.pullRequestUrl && (
        <p className="wf-run-meta">
          <Tooltip label="Open the pull request on GitHub">
            <a href={state.pullRequestUrl} target="_blank" rel="noreferrer">
              {state.pullRequestKey ?? state.pullRequestUrl}
            </a>
          </Tooltip>
          {state.expectedHeadOid ? ` · head ${state.expectedHeadOid.slice(0, 12)}` : ""}
          {` · limit ${state.timeoutMinutes} min`}
        </p>
      )}
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
        </>
      )}
      {state.outcome === "pass" && (
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
      {state.checkRuns.length > 0 && (
        <details open={state.outcome === null}>
          <Tooltip label="Show every check GitHub reported on the head commit">
            <summary>{`Checks on the head commit (${state.checkRuns.length})`}</summary>
          </Tooltip>
          <ul className="wf-run-ci-checks" aria-label="CI checks">
            {state.checkRuns.map((run, index) => (
              <li key={`${index}:${run.name}`} className={`is-${run.state}`}>
                <span>{run.name}</span> <span className="wf-run-meta">{CHECK_STATE_WORDS[run.state]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {state.outcome === null && state.checkRuns.length === 0 && (
        <p className="wf-run-meta">
          {state.observedAt === null
            ? "GitHub Inspector has not read CI for this head yet."
            : "No CI check has appeared on this head yet."}
        </p>
      )}
    </section>
  );
}
