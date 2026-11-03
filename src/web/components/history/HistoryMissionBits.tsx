import { historyPrLabel, historyPrUrl, type HistorySessionSummary } from "@shared/history.ts";
import { Tooltip } from "../Tooltip.tsx";

/**
 * A bound task's status and outcome, and the session's pull request: what Mission Control adds
 * to a row or a header. Nothing for a session no task ran and no PR names.
 */
export function HistoryMissionBits({ row }: { row: Pick<HistorySessionSummary, "mission" | "prUrls"> }): React.JSX.Element | null {
  const task = row.mission?.task ?? null;
  const pr = historyPrUrl(row);
  if (!task && !pr) return null;
  return (
    <>
      {task ? (
        <Tooltip label={`The task that ran this session is ${task.status}`}>
          <span className={`history-badge status-${task.status}`}>{task.status}</span>
        </Tooltip>
      ) : null}
      {task?.outcome ? (
        task.outcomeUrl ? (
          <Tooltip label={`Outcome: ${task.outcome} - open on GitHub`}>
            <a className="history-outcome" href={task.outcomeUrl} target="_blank" rel="noreferrer">{task.outcome}</a>
          </Tooltip>
        ) : (
          <span className="history-outcome">{task.outcome}</span>
        )
      ) : null}
      {pr ? (
        <Tooltip label={row.mission?.mergedAt ? "This pull request merged - open it on GitHub" : "Open this pull request on GitHub"}>
          <a className="mono history-pr" href={pr} target="_blank" rel="noreferrer">
            {historyPrLabel(pr)}{row.mission?.mergedAt ? " merged" : ""}
          </a>
        </Tooltip>
      ) : null}
    </>
  );
}
