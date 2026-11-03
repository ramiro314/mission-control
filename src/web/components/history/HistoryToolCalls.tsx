import { useState } from "react";
import type { HistoryToolResult } from "@shared/history.ts";
import type { AgentType, ToolCall } from "@shared/types.ts";
import { api } from "../../lib/api.ts";
import { toolChip } from "../../lib/tools.ts";
import { Tooltip } from "../Tooltip.tsx";

/**
 * A conversation row's tool calls, each expandable to its whole input and, read on demand,
 * its result. Drawn under the row by `ConversationMessages`' `toolDetails` hook, so the live
 * panel, which passes none, is unchanged.
 *
 * `results` is false for a subagent run: its results are in its own transcript, which the
 * result route does not read, so its calls show their input only.
 */
export function HistoryToolCalls({
  agent,
  id,
  tools,
  results = true,
}: {
  agent: AgentType;
  id: string;
  tools: ToolCall[];
  results?: boolean;
}): React.JSX.Element {
  return (
    <ul className="history-tool-calls" aria-label="Tool calls">
      {tools.map((tool, i) => (
        <HistoryToolCall key={tool.id ?? `${tool.name}-${i}`} agent={agent} id={id} tool={tool} results={results} />
      ))}
    </ul>
  );
}

type ResultState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; result: HistoryToolResult }
  | { state: "unavailable"; error: string };

/** The input as JSON laid out to read, or as recorded when it was cut and no longer parses. */
function readableInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

function HistoryToolCall({
  agent,
  id,
  tool,
  results,
}: {
  agent: AgentType;
  id: string;
  tool: ToolCall;
  results: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ResultState>({ state: "idle" });
  const chip = toolChip(tool);
  const toolUseId = tool.id;

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (!next || !results || !toolUseId || result.state !== "idle") return;
    setResult({ state: "loading" });
    void api.historyToolResult(agent, id, toolUseId).then((read) => {
      setResult(read.ok ? { state: "ready", result: read.value } : { state: "unavailable", error: read.error });
    });
  };

  return (
    <li className={`history-tool-call${open ? " is-open" : ""}`}>
      <Tooltip label={results ? "Show this call's whole input and its result" : "Show this call's whole input"}>
        <button type="button" className="history-tool-toggle" aria-expanded={open} onClick={toggle}>
          <span className="history-tool-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span className="history-tool-name">{chip.name}</span>
          {chip.detail ? <>{" "}<span className="history-tool-detail">{chip.detail}</span></> : null}
        </button>
      </Tooltip>
      {open ? (
        <div className="history-tool-body">
          <section aria-label="Input" className="history-tool-section">
            <h4>Input</h4>
            {tool.input ? <pre className="history-tool-pre">{readableInput(tool.input)}</pre> : <p className="history-tool-note">No input recorded.</p>}
          </section>
          {results ? (
            <section aria-label="Result" className="history-tool-section">
              <h4>
                Result
                {result.state === "ready" && result.result.isError ? <span className="history-badge history-badge-gone">Error</span> : null}
              </h4>
              {!toolUseId ? (
                <p className="history-tool-note" role="note">Result unavailable: this call recorded no id to find it by.</p>
              ) : result.state === "loading" || result.state === "idle" ? (
                <p className="history-tool-note">Reading the result…</p>
              ) : result.state === "unavailable" ? (
                <p className="history-tool-note" role="note">Result unavailable: {result.error}</p>
              ) : (
                <>
                  {result.result.source === "sidecar" ? (
                    <p className="history-tool-note">Read from the file Claude Code saved the whole output to.</p>
                  ) : null}
                  <pre className="history-tool-pre">{result.result.text || "(empty)"}</pre>
                  {result.result.truncated ? <p className="history-tool-note">Cut at 1 MB.</p> : null}
                </>
              )}
            </section>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
