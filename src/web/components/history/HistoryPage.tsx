import { useMemo } from "react";
import {
  HISTORY_KIND_LABELS,
  historyTitle,
  type HistoryProgress,
  type HistorySessionSummary,
} from "@shared/history.ts";
import { fmtUsd } from "@shared/cost.ts";
import { duration, repoLeaf, shortenCwd } from "../../lib/format.ts";
import { missionRouteHash, type MissionRoute } from "../../workflows/useWorkflowRoute.ts";
import { Tooltip } from "../Tooltip.tsx";
import { HistorySessionView } from "./HistorySessionView.tsx";
import { useHistoryCatalog } from "./useHistoryCatalog.ts";

/**
 * The History page: every agent session this machine holds on disk, newest activity first,
 * grouped by day, and one session's detail when the route names it. Conversations only for
 * now; background runs and filters are later surfaces of the same catalog (`docs/history.md`).
 *
 * The list's catalog is held here, above both views, so opening a session and coming Back
 * returns to the rows already paged to rather than to a fresh first page.
 */

function dayLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The progress line's words, or null when nothing is being indexed. */
export function historyProgressLine(progress: HistoryProgress | null): string | null {
  if (!progress?.indexing) return null;
  if (progress.total === 0) return "Indexing sessions…";
  const n = (value: number) => value.toLocaleString("en-US");
  return `Indexing ${n(progress.indexed)} of ${n(progress.total)} sessions`;
}

function HistoryRow({ row }: { row: HistorySessionSummary }): React.JSX.Element {
  const place = row.repoRoot ? repoLeaf(row.repoRoot) : shortenCwd(row.cwd);
  const gone = row.transcriptState === "gone";
  // A link, so the row opens through the router like any other address (and Back undoes it),
  // and a session can be opened in a new tab or copied.
  const href = missionRouteHash({ page: "history", session: { agent: row.agent, id: row.agentSessionId } });
  return (
    <li className={`history-row${gone ? " is-gone" : ""}`}>
      <div className="history-row-head">
        <a className="history-row-title" href={href}>{historyTitle(row)}</a>
        <span className="history-badge">{HISTORY_KIND_LABELS[row.kind] ?? row.kind}</span>
        {row.liveSessionId ? <span className="history-badge history-badge-live">Live</span> : null}
        {gone ? <span className="history-badge history-badge-gone">Transcript gone</span> : null}
      </div>
      <div className="history-row-meta">
        <span className="mono">{clockLabel(row.lastActivityAt)}</span>
        <Tooltip label={row.cwd ?? "No working directory was recorded"}>
          <span className="mono history-row-place">{place}</span>
        </Tooltip>
        {row.branch ? <span className="mono">⎇ {row.branch}</span> : null}
        {row.model ? <span className="mono">{row.model}</span> : null}
        {row.costUsd !== null ? <span className="mono">{fmtUsd(row.costUsd)}</span> : null}
        {row.durationMs ? <span className="mono">{duration(row.durationMs)}</span> : null}
      </div>
    </li>
  );
}

export function HistoryPage({
  route,
  navigate,
  onOpenSession,
}: {
  route: Extract<MissionRoute, { page: "history" }>;
  navigate: (route: MissionRoute) => boolean;
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  const catalog = useHistoryCatalog();
  const progressLine = historyProgressLine(catalog.progress);

  const groups = useMemo(() => {
    const out: { day: string; rows: HistorySessionSummary[] }[] = [];
    for (const row of catalog.sessions) {
      const day = dayLabel(row.lastActivityAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(row);
      else out.push({ day, rows: [row] });
    }
    return out;
  }, [catalog.sessions]);

  if (route.session) {
    return (
      <HistorySessionView
        key={`${route.session.agent}:${route.session.id}`}
        agent={route.session.agent}
        id={route.session.id}
        onBack={() => navigate({ page: "history" })}
        onOpenSession={onOpenSession}
      />
    );
  }

  return (
    <main className="workflow-page history-page" aria-label="History">
      <header className="workflow-page-head">
        <div>
          <p className="workflow-eyebrow">Sessions</p>
          <h2>History</h2>
        </div>
        <p className="workflow-page-blurb">
          Every conversation this machine keeps on disk, whether or not Mission Control ran it.
        </p>
      </header>

      <p className="history-progress" role="status" aria-live="polite">{progressLine ?? ""}</p>

      {catalog.listState === "error" ? (
        <div className="history-empty" role="alert">
          <p className="empty-title">History is unavailable</p>
          <p className="empty-sub">{catalog.listError}</p>
          <Tooltip label="Ask the daemon for the History catalog again">
            <button type="button" className="btn" onClick={catalog.refresh}>Try again</button>
          </Tooltip>
        </div>
      ) : catalog.listState === "first" ? (
        <p className="history-loading">Reading the catalog…</p>
      ) : catalog.sessions.length === 0 ? (
        <div className="history-empty">
          <p className="empty-title">{progressLine ? "No conversations indexed yet" : "No conversations recorded yet"}</p>
          <p className="empty-sub">Claude Code sessions under ~/.claude/projects appear here.</p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.day} className="history-group" aria-label={group.day}>
            <h3 className="history-day">{group.day}</h3>
            <ul className="history-rows">
              {group.rows.map((row) => <HistoryRow key={`${row.agent}:${row.agentSessionId}`} row={row} />)}
            </ul>
          </section>
        ))
      )}

      {catalog.hasMore && catalog.listState === "ready" ? (
        <div className="history-foot">
          {catalog.moreError ? (
            <p className="history-more-error" role="alert">
              Could not load older sessions: {catalog.moreError}
            </p>
          ) : null}
          <Tooltip label="Fetch the next page of older sessions">
            <button type="button" className="btn" onClick={catalog.loadMore} disabled={catalog.loadingMore}>
              {catalog.loadingMore ? "Loading…" : "Load more"}
            </button>
          </Tooltip>
        </div>
      ) : null}
    </main>
  );
}
