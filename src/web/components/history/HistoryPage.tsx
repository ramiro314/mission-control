import { useMemo } from "react";
import { historyTitle, type HistoryProgress, type HistorySessionSummary } from "@shared/history.ts";
import { fmtUsd } from "@shared/cost.ts";
import { duration, repoLeaf, shortenCwd } from "../../lib/format.ts";
import { Tooltip } from "../Tooltip.tsx";
import { useHistoryCatalog } from "./useHistoryCatalog.ts";

/**
 * The History page: every agent session this machine holds on disk, newest activity first,
 * grouped by day. Conversations only for now; background runs, filters and a session's own
 * detail are later surfaces of the same catalog (`docs/history.md`).
 */

const KIND_LABEL: Record<string, string> = {
  interactive: "Interactive",
  sdk: "SDK",
  one_shot: "One-shot",
  reviewer: "Reviewer",
  unclassified: "Unclassified",
};

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
  return (
    <li className={`history-row${gone ? " is-gone" : ""}`}>
      <div className="history-row-head">
        <span className="history-row-title">{historyTitle(row)}</span>
        <span className="history-badge">{KIND_LABEL[row.kind] ?? row.kind}</span>
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

export function HistoryPage({ revision }: {
  /** `historyRevision` from the event stream: bumps per changing reconcile pass and per reconnect. */
  revision: number;
}): React.JSX.Element {
  const catalog = useHistoryCatalog(revision);
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
