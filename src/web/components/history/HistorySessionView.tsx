import { useEffect, useMemo, useState } from "react";
import {
  HISTORY_KIND_LABELS,
  historyResumeOffered,
  historyTitle,
  type HistorySessionSummary,
  type HistorySubagent,
} from "@shared/history.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { fmtUsd } from "@shared/cost.ts";
import type { AgentType } from "@shared/types.ts";
import { api } from "../../lib/api.ts";
import { duration, promptPath } from "../../lib/format.ts";
import { transcriptRows } from "../../lib/tools.ts";
import { agentAccentStyle } from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { ConversationMessages } from "../TranscriptPanel.tsx";
import { HistoryLaunchContextView } from "./HistoryLaunchContext.tsx";
import { HistoryResumeDialog } from "./HistoryResumeDialog.tsx";
import { HistorySubagentRuns } from "./HistorySubagentRuns.tsx";
import { HistoryToolCalls } from "./HistoryToolCalls.tsx";
import { useHistoryConversation } from "./useHistoryConversation.ts";

/**
 * One History session: a header of what the catalog recorded, then two read-only tabs - its
 * conversation, and the context it was launched with.
 *
 * The conversation is read from disk when the view opens and paged forward from the top. A
 * session the Registry is running still reads this way - it never streams here; Open in Fleet
 * is where it is live. Each tool call opens to its whole input and its result, read on demand,
 * and each subagent run opens its own transcript in place.
 */

const RETENTION_MESSAGE =
  "This conversation was removed by Claude Code's retention: it deletes transcripts older than its cleanupPeriodDays setting. History keeps the record above.";

function stamp(at: number | null): string | null {
  return at === null ? null : new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type DetailState =
  | { state: "loading" }
  | { state: "ready"; session: HistorySessionSummary; subagents: HistorySubagent[] }
  | { state: "missing" }
  | { state: "error"; error: string };

function MetaItem({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element | null {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="history-meta-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function HistorySessionHeader({
  session,
  onOpenSession,
}: {
  session: HistorySessionSummary;
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  const gone = session.transcriptState === "gone";
  const live = session.liveSessionId;
  const [resuming, setResuming] = useState(false);
  return (
    <header className="history-detail-head">
      <div className="history-detail-title">
        <h2>{historyTitle(session)}</h2>
        <span className="history-badge">{HISTORY_KIND_LABELS[session.kind] ?? session.kind}</span>
        {live ? <span className="history-badge history-badge-live">Live</span> : null}
        {gone ? <span className="history-badge history-badge-gone">Transcript gone</span> : null}
        {live ? (
          <Tooltip label="This session is running now: open its live card on the Fleet">
            <button type="button" className="btn history-detail-action" onClick={() => onOpenSession(live)}>
              Open in Fleet
            </button>
          </Tooltip>
        ) : historyResumeOffered(session) ? (
          <Tooltip label="Reopen this conversation in a new terminal, in its original directory">
            <button type="button" className="btn history-detail-action" onClick={() => setResuming(true)}>
              Resume
            </button>
          </Tooltip>
        ) : null}
      </div>
      {resuming ? <HistoryResumeDialog session={session} onClose={() => setResuming(false)} /> : null}
      <dl className="history-meta">
        <MetaItem label="Repository">{session.repoRoot ? <span className="mono">{session.repoRoot}</span> : null}</MetaItem>
        <MetaItem label="Branch">{session.branch ? <span className="mono">{session.branch}</span> : null}</MetaItem>
        <MetaItem label="Working directory">{session.cwd ? <span className="mono">{session.cwd}</span> : null}</MetaItem>
        <MetaItem label="Kind">{HISTORY_KIND_LABELS[session.kind] ?? session.kind}</MetaItem>
        <MetaItem label="Model">{session.model ? <span className="mono">{session.model}</span> : null}</MetaItem>
        <MetaItem label="Started">{stamp(session.startedAt)}</MetaItem>
        <MetaItem label="Last activity">{stamp(session.lastActivityAt)}</MetaItem>
        <MetaItem label="Duration">{session.durationMs ? duration(session.durationMs) : null}</MetaItem>
        <MetaItem label="Cost">{session.costUsd !== null ? fmtUsd(session.costUsd) : null}</MetaItem>
      </dl>
    </header>
  );
}

function HistoryConversation({
  session,
  subagents,
}: {
  session: HistorySessionSummary;
  subagents: HistorySubagent[];
}): React.JSX.Element {
  const { agent, agentSessionId: id } = session;
  const conversation = useHistoryConversation(
    (cursor, signal) => api.historyMessages(agent, id, cursor, signal),
    `${agent}:${id}`,
    session.transcriptState === "present",
  );
  const rows = useMemo(() => transcriptRows(conversation.messages), [conversation.messages]);
  if (session.transcriptState === "gone" || conversation.state === "gone") {
    return <p className="history-gone" role="note">{RETENTION_MESSAGE}</p>;
  }
  if (conversation.state === "error") {
    return (
      <div className="history-empty" role="alert">
        <p className="empty-title">Could not read this conversation</p>
        <p className="empty-sub">{conversation.error}</p>
        <Tooltip label="Read this session's transcript again">
          <button type="button" className="btn" onClick={conversation.retry}>Try again</button>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="history-conversation" style={agentAccentStyle(session.agent)}>
      <HistorySubagentRuns agent={agent} id={id} cwd={session.cwd} subagents={subagents} />
      {conversation.state === "loading" ? <p className="history-loading">Reading the transcript…</p> : null}
      {conversation.state === "ready" && rows.length === 0 && !conversation.hasMore ? (
        <p className="transcript-empty">This transcript holds no messages.</p>
      ) : null}
      <ConversationMessages
        rows={rows}
        agentLabel={AGENT_IDENTITY[session.agent].speaker}
        terminal={false}
        // No checkout listing, so no artifact is ever discovered and nothing opens a file.
        sessionId={`history:${session.agent}:${session.agentSessionId}`}
        cwd={promptPath(session.cwd)}
        fullCwd={session.cwd}
        toolDetails={(_rowId, tools) => <HistoryToolCalls agent={agent} id={id} tools={tools} />}
      />
      {conversation.hasMore && conversation.state === "ready" ? (
        <div className="history-foot">
          {conversation.error ? (
            <p className="history-more-error" role="alert">Could not load more messages: {conversation.error}</p>
          ) : null}
          <Tooltip label="Read the next stretch of this conversation">
            <button type="button" className="btn" onClick={conversation.loadMore} disabled={conversation.loadingMore}>
              {conversation.loadingMore ? "Loading…" : "Load more messages"}
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}

type HistoryTab = "conversation" | "launch";

const HISTORY_TABS: { id: HistoryTab; label: string; hint: string }[] = [
  { id: "conversation", label: "Conversation", hint: "The session's messages, read from its transcript on disk" },
  {
    id: "launch",
    label: "Launch context",
    hint: "Instruction files, prompts, skills, MCP servers, environment and hooks, as the transcript recorded them",
  },
];

/**
 * The detail's two tabs. A tab's panel mounts the first time it is chosen and then stays,
 * hidden while the other shows, so switching back never reads its transcript again.
 */
function HistorySessionTabs({
  session,
  subagents,
}: {
  session: HistorySessionSummary;
  subagents: HistorySubagent[];
}): React.JSX.Element {
  const [tab, setTab] = useState<HistoryTab>("conversation");
  const [opened, setOpened] = useState<ReadonlySet<HistoryTab>>(() => new Set(["conversation"]));
  const choose = (next: HistoryTab) => {
    setTab(next);
    setOpened((prev) => (prev.has(next) ? prev : new Set([...prev, next])));
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const at = HISTORY_TABS.findIndex((t) => t.id === tab);
    const next = HISTORY_TABS[(at + (event.key === "ArrowRight" ? 1 : -1) + HISTORY_TABS.length) % HISTORY_TABS.length]!;
    choose(next.id);
    document.getElementById(`history-tab-${next.id}`)?.focus();
  };
  return (
    <>
      <div className="history-tabs" role="tablist" aria-label="Session view" onKeyDown={onKeyDown}>
        {HISTORY_TABS.map((t) => (
          <Tooltip key={t.id} label={t.hint}>
            <button
              type="button"
              role="tab"
              id={`history-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`history-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={tab === t.id ? "history-tab is-active" : "history-tab"}
              onClick={() => choose(t.id)}
            >
              {t.label}
            </button>
          </Tooltip>
        ))}
      </div>
      {HISTORY_TABS.filter((t) => opened.has(t.id)).map((t) => (
        <section
          key={t.id}
          role="tabpanel"
          id={`history-panel-${t.id}`}
          aria-labelledby={`history-tab-${t.id}`}
          className="history-tabpanel"
          hidden={tab !== t.id}
        >
          {t.id === "conversation"
            ? <HistoryConversation session={session} subagents={subagents} />
            : <HistoryLaunchContextView session={session} retentionMessage={RETENTION_MESSAGE} />}
        </section>
      ))}
    </>
  );
}

export function HistorySessionView({
  agent,
  id,
  onBack,
  onOpenSession,
}: {
  agent: AgentType;
  id: string;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  const [detail, setDetail] = useState<DetailState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setDetail({ state: "loading" });
    void api.historySession(agent, id, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) setDetail({ state: "ready", session: result.value.session, subagents: result.value.subagents });
      else if (result.status === 404) setDetail({ state: "missing" });
      else setDetail({ state: "error", error: result.error });
    });
    return () => controller.abort();
  }, [agent, id, attempt]);

  return (
    <main className="workflow-page history-page history-detail" aria-label="History session">
      <Tooltip label="Back to the History list">
        <button type="button" className="history-back" onClick={onBack}>← History</button>
      </Tooltip>
      {detail.state === "loading" ? (
        <p className="history-loading">Reading the session…</p>
      ) : detail.state === "missing" ? (
        <div className="history-empty">
          <p className="empty-title">This session is not in History</p>
          <p className="empty-sub">No session with this id has been indexed from this machine's transcripts.</p>
        </div>
      ) : detail.state === "error" ? (
        <div className="history-empty" role="alert">
          <p className="empty-title">History is unavailable</p>
          <p className="empty-sub">{detail.error}</p>
          <Tooltip label="Ask the daemon for this session again">
            <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          </Tooltip>
        </div>
      ) : (
        <>
          <HistorySessionHeader session={detail.session} onOpenSession={onOpenSession} />
          <HistorySessionTabs session={detail.session} subagents={detail.subagents} />
        </>
      )}
    </main>
  );
}
