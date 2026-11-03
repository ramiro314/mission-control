import { useMemo, useState } from "react";
import type { HistorySubagent } from "@shared/history.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import type { AgentType } from "@shared/types.ts";
import { api } from "../../lib/api.ts";
import { promptPath } from "../../lib/format.ts";
import { transcriptRows } from "../../lib/tools.ts";
import { Tooltip } from "../Tooltip.tsx";
import { ConversationMessages } from "../TranscriptPanel.tsx";
import { HistoryToolCalls } from "./HistoryToolCalls.tsx";
import { useHistoryConversation } from "./useHistoryConversation.ts";

/** The subagent runs a session started, each opening its own transcript in place. */
export function HistorySubagentRuns({
  agent,
  id,
  cwd,
  subagents,
}: {
  agent: AgentType;
  id: string;
  cwd: string | null;
  subagents: HistorySubagent[];
}): React.JSX.Element | null {
  if (subagents.length === 0) return null;
  return (
    <section className="history-subagents" aria-label="Subagent runs">
      <h3>Subagent runs</h3>
      <ul>
        {subagents.map((run) => <HistorySubagentRun key={run.agentId} agent={agent} id={id} cwd={cwd} run={run} />)}
      </ul>
    </section>
  );
}

function subagentLabel(run: HistorySubagent): string {
  const what = run.description ?? run.firstPrompt ?? run.agentId;
  return run.agentType ? `${run.agentType}: ${what}` : what;
}

function HistorySubagentRun({
  agent,
  id,
  cwd,
  run,
}: {
  agent: AgentType;
  id: string;
  cwd: string | null;
  run: HistorySubagent;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const label = subagentLabel(run);
  return (
    <li className={`history-subagent${open ? " is-open" : ""}`}>
      <Tooltip label={open ? "Close this subagent run's transcript" : "Read this subagent run's own transcript here"}>
        <button type="button" className="history-subagent-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="history-tool-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span className="history-subagent-label">{label}</span>
        </button>
      </Tooltip>
      {open ? <HistorySubagentTranscript agent={agent} id={id} cwd={cwd} run={run} label={label} /> : null}
    </li>
  );
}

function HistorySubagentTranscript({
  agent,
  id,
  cwd,
  run,
  label,
}: {
  agent: AgentType;
  id: string;
  cwd: string | null;
  run: HistorySubagent;
  label: string;
}): React.JSX.Element {
  const conversation = useHistoryConversation(
    (cursor, signal) => api.historySubagentMessages(agent, id, run.agentId, cursor, signal),
    `${agent}:${id}:${run.agentId}`,
    true,
  );
  // Every user turn in a subagent run was written by the parent session, never by the
  // operator, so it is bylined as delegated from it rather than as "you".
  const rows = useMemo(() => transcriptRows(conversation.messages.map((m) => (
    m.role === "user" && !m.origin
      ? { ...m, origin: "session" as const, originSession: { id, name: AGENT_IDENTITY[agent].speaker } }
      : m
  ))), [agent, conversation.messages, id]);
  return (
    <div className="history-subagent-transcript" role="region" aria-label={`Subagent transcript: ${label}`}>
      {conversation.state === "loading" ? <p className="history-loading">Reading the subagent's transcript…</p> : null}
      {conversation.state === "gone" ? <p className="history-gone" role="note">This subagent's transcript is no longer on disk.</p> : null}
      {conversation.state === "error" ? (
        <p className="history-more-error" role="alert">Could not read this subagent run: {conversation.error}</p>
      ) : null}
      {conversation.state === "ready" && rows.length === 0 && !conversation.hasMore ? (
        <p className="transcript-empty">This subagent run holds no messages.</p>
      ) : null}
      <ConversationMessages
        rows={rows}
        agentLabel={run.agentType ?? AGENT_IDENTITY[agent].speaker}
        terminal={false}
        sessionId={`history:${agent}:${id}:${run.agentId}`}
        cwd={promptPath(cwd)}
        fullCwd={cwd}
        toolDetails={(_rowId, tools) => <HistoryToolCalls agent={agent} id={id} tools={tools} results={false} />}
      />
      {conversation.hasMore && conversation.state === "ready" ? (
        <div className="history-foot">
          {conversation.error ? (
            <p className="history-more-error" role="alert">Could not load more messages: {conversation.error}</p>
          ) : null}
          <Tooltip label="Read the next stretch of this subagent run">
            <button type="button" className="btn" onClick={conversation.loadMore} disabled={conversation.loadingMore}>
              {conversation.loadingMore ? "Loading…" : "Load more subagent messages"}
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
