import { useCallback, useEffect, useMemo, useState } from "react";
import {
  HISTORY_KINDS,
  historyTitle,
  type HistoryKindFilter,
  type HistoryProgress,
  type HistoryRetention,
  type HistorySessionSummary,
} from "@shared/history.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import type { AgentType } from "@shared/types.ts";
import { fmtUsd } from "@shared/cost.ts";
import { duration, repoLeaf, shortenCwd } from "../../lib/format.ts";
import type { HistoryFilters, MissionRoute } from "../../workflows/useWorkflowRoute.ts";
import { Tooltip } from "../Tooltip.tsx";
import { useHistoryCatalog } from "./useHistoryCatalog.ts";

/**
 * The History page: every agent session this machine holds on disk, newest activity first,
 * grouped by day. Conversations by default; the Kind filter adds background runs. Search and
 * filters live in the route, which the page replaces as they change. A session's own detail is
 * a later surface of the same catalog (`docs/history.md`).
 */

/** How long typing settles before the search reaches the route, as on the Scouts page. */
const SEARCH_DEBOUNCE_MS = 220;

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

/** "Claude Code keeps transcripts for 30 days", with a link to where that is set. */
function RetentionLine({ retention }: { retention: HistoryRetention }): React.JSX.Element {
  const label = AGENT_IDENTITY[retention.agent].label;
  return (
    <p className="history-retention">
      {label} keeps transcripts for {retention.days} {retention.days === 1 ? "day" : "days"}.{" "}
      <Tooltip label={`${label}'s ${retention.setting} setting decides this. Mission Control never changes it.`}>
        <a href={retention.settingUrl} target="_blank" rel="noreferrer">
          <code>{retention.setting}</code>
        </a>
      </Tooltip>
    </p>
  );
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

export function HistoryPage({
  route,
  replace,
}: {
  route: Extract<MissionRoute, { page: "history" }>;
  replace: (route: MissionRoute) => void;
}): React.JSX.Element {
  const filters = route.filters;
  const catalog = useHistoryCatalog(filters);
  const progressLine = historyProgressLine(catalog.progress);
  const facets = catalog.facets;

  // Every filter REPLACES the route: a list refined control by control must not leave a trail
  // of entries for Back to walk out of. The route stays the source of truth, so a pasted link,
  // the palette or a reload all land on the same list.
  const setFilters = useCallback((next: HistoryFilters): void => {
    const cleaned = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined && value !== ""),
    ) as HistoryFilters;
    replace({ page: "history", ...(Object.keys(cleaned).length > 0 ? { filters: cleaned } : {}) });
  }, [replace]);

  // The search box is local while it is typed, and reaches the route once typing settles.
  const routeQuery = filters?.q ?? "";
  const [draftQuery, setDraftQuery] = useState(routeQuery);
  useEffect(() => setDraftQuery(routeQuery), [routeQuery]);
  useEffect(() => {
    if (draftQuery === routeQuery) return;
    const timer = setTimeout(() => setFilters({ ...filters, q: draftQuery || undefined }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftQuery, routeQuery, filters, setFilters]);

  const narrowed = !!(filters?.repo || filters?.from || filters?.to || filters?.kind || filters?.agent);
  const searching = routeQuery !== "" || narrowed;
  // The route may name a repository the catalog no longer lists; it stays selectable so the
  // select never shows a value it has no option for.
  const repositories = useMemo(() => {
    const listed = facets?.repositories ?? [];
    return filters?.repo && !listed.includes(filters.repo) ? [filters.repo, ...listed] : listed;
  }, [facets?.repositories, filters?.repo]);
  const agents = facets?.agents ?? [];

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

      {facets?.retention.map((retention) => <RetentionLine key={retention.agent} retention={retention} />)}

      <div className="history-filters" role="search" aria-label="Filter history">
        <input
          className="field-input history-search"
          type="search"
          aria-label="Search history"
          placeholder="Search titles, prompts, paths, branches..."
          autoComplete="off"
          spellCheck={false}
          value={draftQuery}
          onChange={(event) => setDraftQuery(event.target.value)}
        />
        <label className="history-filter">
          <span className="history-filter-label">Repository</span>
          <Tooltip label="Show sessions from one repository. Worktree slots count as their repository.">
            <select
              className="history-filter-select"
              aria-label="Repository"
              value={filters?.repo ?? ""}
              onChange={(event) => setFilters({ ...filters, repo: event.target.value || undefined })}
            >
              <option value="">Any repository</option>
              {repositories.map((repo) => <option key={repo} value={repo}>{shortenCwd(repo)}</option>)}
            </select>
          </Tooltip>
        </label>
        <label className="history-filter">
          <span className="history-filter-label">From</span>
          <Tooltip label="Show sessions last active on or after this day">
            <input
              className="history-filter-date"
              type="date"
              aria-label="From"
              value={filters?.from ?? ""}
              max={filters?.to}
              onChange={(event) => setFilters({ ...filters, from: event.target.value || undefined })}
            />
          </Tooltip>
        </label>
        <label className="history-filter">
          <span className="history-filter-label">To</span>
          <Tooltip label="Show sessions last active on or before this day">
            <input
              className="history-filter-date"
              type="date"
              aria-label="To"
              value={filters?.to ?? ""}
              min={filters?.from}
              onChange={(event) => setFilters({ ...filters, to: event.target.value || undefined })}
            />
          </Tooltip>
        </label>
        <label className="history-filter">
          <span className="history-filter-label">Kind</span>
          <Tooltip label="Conversations by default. Choose All kinds to add one-shot and reviewer runs.">
            <select
              className="history-filter-select"
              aria-label="Kind"
              value={filters?.kind ?? ""}
              onChange={(event) =>
                setFilters({ ...filters, kind: (event.target.value || undefined) as HistoryKindFilter | undefined })}
            >
              <option value="">Conversations</option>
              <option value="all">All kinds</option>
              {HISTORY_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind] ?? kind}</option>)}
            </select>
          </Tooltip>
        </label>
        {/* Only worth a control once a second harness has a history reader. */}
        {agents.length > 1 ? (
          <label className="history-filter">
            <span className="history-filter-label">Agent</span>
            <Tooltip label="Show sessions from one agent">
              <select
                className="history-filter-select"
                aria-label="Agent"
                value={filters?.agent ?? ""}
                onChange={(event) =>
                  setFilters({ ...filters, agent: (event.target.value || undefined) as AgentType | undefined })}
              >
                <option value="">Any agent</option>
                {agents.map((agent) => <option key={agent} value={agent}>{AGENT_IDENTITY[agent].label}</option>)}
              </select>
            </Tooltip>
          </label>
        ) : null}
        {narrowed ? (
          <Tooltip label="Drop every filter and keep the words you searched for">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setFilters(filters?.q ? { q: filters.q } : {})}
            >
              Clear filters
            </button>
          </Tooltip>
        ) : null}
      </div>

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
        searching ? (
          <div className="history-empty">
            <p className="empty-title">No sessions match</p>
            <p className="empty-sub">Try fewer words, or clear the filters.</p>
          </div>
        ) : (
          <div className="history-empty">
            <p className="empty-title">{progressLine ? "No conversations indexed yet" : "No conversations recorded yet"}</p>
            <p className="empty-sub">Claude Code sessions under ~/.claude/projects appear here.</p>
          </div>
        )
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
