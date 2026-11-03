import { useEffect, useState } from "react";
import type {
  HistoryEnvironment,
  HistoryHookRun,
  HistoryInstructionFile,
  HistoryLaunchContext,
  HistoryMcp,
  HistorySessionSummary,
  HistorySkills,
  HistorySystemPrompt,
} from "@shared/history.ts";
import { api } from "../../lib/api.ts";
import { duration } from "../../lib/format.ts";
import { Tooltip } from "../Tooltip.tsx";

/**
 * A History session's Launch context tab: what the session was launched with, as its
 * transcript recorded it. Parsed by the daemon on demand, never from the catalog.
 *
 * Every section either lists what was recorded or says "Not recorded". A missing record is
 * never drawn as an empty list: the transcript holding nothing about a section does not mean
 * the session had nothing.
 */

type LaunchState =
  | { state: "loading" }
  | { state: "ready"; context: HistoryLaunchContext }
  | { state: "gone" }
  | { state: "error"; error: string };

const NOT_RECORDED = "Not recorded";

const REASON_LABELS: Readonly<Record<string, string>> = {
  session_start: "Loaded at session start",
  compaction: "Reloaded after compaction",
};

const MCP_STATUS_LABELS: Readonly<Record<string, string>> = {
  connected: "Connected",
  pending: "Pending",
  needs_auth: "Needs authentication",
  failed: "Failed",
};

function ms(value: number): string {
  return value < 1_000 ? `${Math.round(value)} ms` : duration(value);
}

function Absent({ children = NOT_RECORDED }: { children?: string }): React.JSX.Element {
  return <p className="history-launch-absent">{children}</p>;
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="history-launch-section" aria-labelledby={`history-launch-${id}`}>
      <h3 id={`history-launch-${id}`}>{title}</h3>
      {children}
    </section>
  );
}

function Names({ label, names }: { label: string; names: string[] }): React.JSX.Element {
  return (
    <ul className="history-launch-names" aria-label={label}>
      {names.map((name) => <li key={name} className="mono">{name}</li>)}
    </ul>
  );
}

function InstructionFiles({ files }: { files: HistoryInstructionFile[] | null }): React.JSX.Element {
  if (files === null) return <Absent />;
  if (files.length === 0) return <Absent>No instruction files were loaded</Absent>;
  return (
    <ul className="history-launch-list">
      {files.map((file, i) => (
        <li key={`${file.path}:${i}`}>
          <details className="history-launch-file">
            <Tooltip label="Show this file's text as the session loaded it">
              <summary>
                <span className="mono history-launch-path">{file.path}</span>
                {file.scope ? <span className="history-badge">{file.scope}</span> : null}
                <span className="history-launch-reason">
                  {file.reason ? REASON_LABELS[file.reason] ?? file.reason : "Load reason not recorded"}
                </span>
              </summary>
            </Tooltip>
            <pre className="history-launch-text">{file.content}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

function StandingInstructions({ prompt }: { prompt: HistorySystemPrompt | null }): React.JSX.Element {
  if (prompt === null) return <Absent />;
  if (prompt.standingInstructions === null) return <Absent>None appended</Absent>;
  return <pre className="history-launch-text">{prompt.standingInstructions}</pre>;
}

function AppendedPrompt({ prompt }: { prompt: HistorySystemPrompt | null }): React.JSX.Element {
  if (prompt === null) return <Absent />;
  if (prompt.appended.length === 0) return <Absent>None appended</Absent>;
  return (
    <ul className="history-launch-list">
      {prompt.appended.map((block, i) => (
        <li key={i}>
          <details className="history-launch-file">
            <Tooltip label="Show this block of the appended system prompt">
              <summary>
                <span className="history-launch-path">{block.split("\n", 1)[0]!.slice(0, 120) || `Block ${i + 1}`}</span>
              </summary>
            </Tooltip>
            <pre className="history-launch-text">{block}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

function Skills({ skills }: { skills: HistorySkills }): React.JSX.Element {
  return (
    <dl className="history-launch-pairs">
      <div className="history-launch-pair">
        <dt>Available</dt>
        <dd>
          {skills.available === null ? <Absent /> : skills.available.length === 0 ? <Absent>None listed</Absent> : (
            <Names label="Skills available" names={skills.available} />
          )}
        </dd>
      </div>
      <div className="history-launch-pair">
        <dt>Used</dt>
        <dd>{skills.used.length === 0 ? <Absent>None used</Absent> : <Names label="Skills used" names={skills.used} />}</dd>
      </div>
    </dl>
  );
}

function Mcp({ mcp }: { mcp: HistoryMcp | null }): React.JSX.Element {
  if (mcp === null) return <Absent />;
  return (
    <>
      {mcp.servers.length === 0 ? <Absent>No servers recorded</Absent> : (
        <ul className="history-launch-list" aria-label="MCP servers">
          {mcp.servers.map((server) => (
            <li key={server.name} className="history-launch-server">
              <span className="mono">{server.name}</span>
              <span className={`history-badge history-mcp-${server.status}`}>{MCP_STATUS_LABELS[server.status] ?? server.status}</span>
              {server.instructions ? (
                <details className="history-launch-file">
                  <Tooltip label="Show the instructions this server sent the session">
                    <summary>Instructions</summary>
                  </Tooltip>
                  <pre className="history-launch-text">{server.instructions}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {mcp.tools.length > 0 ? (
        <details className="history-launch-file">
          <Tooltip label="Show every MCP tool the session was offered">
            <summary>{mcp.tools.length === 1 ? "1 tool" : `${mcp.tools.length} tools`}</summary>
          </Tooltip>
          <Names label="MCP tools" names={mcp.tools} />
        </details>
      ) : null}
    </>
  );
}

function Environment({ env }: { env: HistoryEnvironment }): React.JSX.Element {
  const flag = (value: boolean | null) => (value === null ? null : value ? "Yes" : "No");
  const rows: [string, React.ReactNode][] = [
    ["Working directory", env.cwd ? <span className="mono">{env.cwd}</span> : null],
    ["Branch", env.branch ? <span className="mono">{env.branch}</span> : null],
    ["Worktree", flag(env.isWorktree)],
    ["Git repository", flag(env.isGitRepo)],
    ["Additional directories", env.additionalDirectories === null ? null
      : env.additionalDirectories.length === 0 ? "None"
      : <Names label="Additional directories" names={env.additionalDirectories} />],
    ["Model", env.model ? <span className="mono">{env.model}</span> : null],
    ["Effort", env.effort],
    ["Permission mode", env.permissionMode],
    ["Platform", [env.platform, env.osVersion, env.shell].filter(Boolean).join(" · ") || null],
  ];
  return (
    <>
      <dl className="history-launch-pairs">
        {rows.map(([label, value]) => (
          <div key={label} className="history-launch-pair">
            <dt>{label}</dt>
            <dd>{value ?? <Absent />}</dd>
          </div>
        ))}
      </dl>
      <h4 className="history-launch-sub">Git status at launch</h4>
      {env.gitStatus ? <pre className="history-launch-text">{env.gitStatus}</pre> : <Absent />}
    </>
  );
}

function Hooks({ hooks }: { hooks: HistoryHookRun[] | null }): React.JSX.Element {
  if (hooks === null) return <Absent />;
  return (
    <table className="history-launch-hooks">
      <thead>
        <tr><th scope="col">Event</th><th scope="col">Command</th><th scope="col">Runs</th><th scope="col">Total</th><th scope="col">Longest</th></tr>
      </thead>
      <tbody>
        {hooks.map((hook) => (
          <tr key={`${hook.event}:${hook.command}`}>
            <td>{hook.event}</td>
            <td className="mono history-launch-command">{hook.command}</td>
            <td>{hook.runs}{hook.failures > 0 ? ` (${hook.failures} failed)` : ""}</td>
            <td>{ms(hook.totalMs)}</td>
            <td>{ms(hook.maxMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HistoryLaunchContextView({
  session,
  retentionMessage,
}: {
  session: HistorySessionSummary;
  retentionMessage: string;
}): React.JSX.Element {
  const gone = session.transcriptState === "gone";
  const [launch, setLaunch] = useState<LaunchState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (gone) return;
    const controller = new AbortController();
    setLaunch({ state: "loading" });
    void api.historyLaunchContext(session.agent, session.agentSessionId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) setLaunch({ state: "ready", context: result.value });
      else if (result.status === 410) setLaunch({ state: "gone" });
      else setLaunch({ state: "error", error: result.error });
    });
    return () => controller.abort();
  }, [session.agent, session.agentSessionId, gone, attempt]);

  if (gone || launch.state === "gone") return <p className="history-gone" role="note">{retentionMessage}</p>;
  if (launch.state === "loading") return <p className="history-loading">Reading the launch context…</p>;
  if (launch.state === "error") {
    return (
      <div className="history-empty" role="alert">
        <p className="empty-title">Could not read the launch context</p>
        <p className="empty-sub">{launch.error}</p>
        <Tooltip label="Read this session's transcript again">
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </Tooltip>
      </div>
    );
  }
  const { context } = launch;
  return (
    <div className="history-launch">
      <p className="history-launch-note">As this session's transcript recorded it at the time, not as the files read today.</p>
      <Section id="instructions" title="Instruction files"><InstructionFiles files={context.instructionFiles} /></Section>
      <Section id="standing" title="Standing instructions"><StandingInstructions prompt={context.systemPrompt} /></Section>
      <Section id="appended" title="Appended system prompt"><AppendedPrompt prompt={context.systemPrompt} /></Section>
      <Section id="skills" title="Skills"><Skills skills={context.skills} /></Section>
      <Section id="mcp" title="MCP servers and tools"><Mcp mcp={context.mcp} /></Section>
      <Section id="environment" title="Environment"><Environment env={context.environment} /></Section>
      <Section id="hooks" title="Hooks"><Hooks hooks={context.hooks} /></Section>
    </div>
  );
}
