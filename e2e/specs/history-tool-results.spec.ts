import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A History session's Conversation tab past what the live view shows: each tool call expands
 * to its whole input and its result, read on demand from the transcript or from the sidecar
 * file its record names; compaction boundaries are marked; and each subagent run opens its
 * own transcript in place, paged.
 *
 * Transcripts, sidecars and subagent runs are written into the daemon's redirected
 * `~/.claude/projects` by this file. No model token is spent.
 */
test.use({ daemonEnv: { MISSION_HISTORY_RECONCILE_MS: "300" } });

const EVIDENCE = artifactsDir("history-tool-results");
const ID = "00000000-0000-4000-a000-000000000001";
const SUBAGENT = "0123abcd";
/** Subagent turn pairs: 160 pairs of about 4 KB span two windows, so the run needs Load more. */
const SUBAGENT_PAIRS = 160;
const LONG_TAIL = "END-OF-THE-WHOLE-INPUT";

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

function jsonl(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** One interactive session with tool calls, a compaction and a subagent run, laid out the way Claude Code writes them. */
function writeSession(daemon: DaemonHandle): void {
  const cwd = "/projects/alpha-service";
  const dir = join(daemon.home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const sessionDir = join(dir, ID);
  const base = { sessionId: ID, cwd, entrypoint: "cli", version: "2.1.296", gitBranch: "fix-login-retry", isSidechain: false };
  const start = Date.parse("2026-10-30T15:00:00.000Z");
  let n = 0;
  const next = () => {
    n += 1;
    return { ...base, timestamp: new Date(start + n * 1_000).toISOString(), uuid: `r-${n}` };
  };
  const use = (id: string, name: string, input: Record<string, unknown>) => ({
    ...next(),
    type: "assistant",
    message: { id: `m-${n}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] },
  });
  const result = (id: string, content: string) => ({
    ...next(),
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
  const saved = join(sessionDir, "tool-results", "toolu_saved.txt");
  const lines = [
    { ...base, timestamp: new Date(start).toISOString(), type: "custom-title", customTitle: "Tool results and subagents" },
    { ...next(), type: "user", message: { role: "user", content: "Run the checks and fix what fails" } },
    use("toolu_inline", "Bash", { command: "git status --short" }),
    result("toolu_inline", " M src/server/registry.ts"),
    use("toolu_saved", "Bash", { command: "npm test" }),
    result("toolu_saved", [
      "<persisted-output>",
      `Output too large (48.2KB). Full output saved to: ${saved}`,
      "",
      "Preview (first 2KB):",
      "running 412 tests",
      "</persisted-output>",
    ].join("\n")),
    use("toolu_long", "Write", { file_path: "/projects/alpha-service/notes.md", content: `${"retry ".repeat(600)}${LONG_TAIL}` }),
    result("toolu_long", "File written"),
    // Never answered: its sidecar is on disk, but no record names it.
    use("toolu_orphan", "Bash", { command: "sleep 600" }),
    { ...next(), type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 167_000 } },
    { ...next(), type: "user", isCompactSummary: true, message: { role: "user", content: "Earlier: the checks ran and one test failed." } },
    use("toolu_agent", "Agent", { description: "Find the retry loop", prompt: "Find where login retries", subagent_type: "Explore" }),
    result("toolu_agent", "Found it in src/server/auth.ts"),
    { ...next(), type: "assistant", message: { id: "m-done", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "All fixed." }] } },
  ];
  mkdirSync(join(sessionDir, "tool-results"), { recursive: true });
  mkdirSync(join(sessionDir, "subagents"), { recursive: true });
  writeFileSync(join(dir, `${ID}.jsonl`), jsonl(lines));
  writeFileSync(saved, "running 412 tests\n...\nall 412 tests passed\n");
  writeFileSync(join(sessionDir, "tool-results", "toolu_orphan.txt"), "an output no record names");

  const sub = [];
  for (let i = 0; i < SUBAGENT_PAIRS; i++) {
    const at = new Date(start + 100_000 + i * 1_000).toISOString();
    const k = String(i).padStart(3, "0");
    sub.push({ ...base, isSidechain: true, agentId: SUBAGENT, timestamp: at, uuid: `s-u-${k}`, type: "user", message: { role: "user", content: `Subagent question ${k}` } });
    sub.push({
      ...base,
      isSidechain: true,
      agentId: SUBAGENT,
      timestamp: at,
      uuid: `s-a-${k}`,
      type: "assistant",
      message: { id: `s-m-${k}`, role: "assistant", content: [{ type: "text", text: `Subagent answer ${k}.${" ".repeat(4_000)}` }] },
    });
  }
  writeFileSync(join(sessionDir, "subagents", `agent-${SUBAGENT}.jsonl`), jsonl(sub));
  writeFileSync(join(sessionDir, "subagents", `agent-${SUBAGENT}.meta.json`), JSON.stringify({ agentType: "Explore", description: "Find the retry loop" }));
  const at = new Date(start);
  utimesSync(join(dir, `${ID}.jsonl`), at, at);
}

async function indexed(daemon: DaemonHandle): Promise<void> {
  await expect.poll(async () => (await fetch(`${daemon.baseURL}/api/history/sessions/claude/${ID}`)).status, { timeout: 30_000 }).toBe(200);
}

test("tool calls expand to their whole input and their result, compaction is marked, and a subagent run opens in place", async ({
  dashboard,
  daemon,
}) => {
  writeSession(daemon);
  await indexed(daemon);

  // Results are read only when a call is opened.
  const resultReads: string[] = [];
  dashboard.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/tool-results/")) resultReads.push(path.split("/").pop()!);
  });

  await dashboard.goto(`${daemon.baseURL}/#/history/claude/${ID}`);
  const detail = dashboard.getByRole("main", { name: "History session" });
  await expect(detail.getByRole("heading", { name: "Tool results and subagents", level: 2 })).toBeVisible();
  const panel = detail.getByRole("tabpanel");
  await expect(panel.getByText("All fixed.")).toBeVisible();
  expect(resultReads).toEqual([]);

  // An inline result.
  const status = panel.getByRole("listitem").filter({ has: dashboard.getByRole("button", { name: "bash git" }) });
  await status.getByRole("button", { name: "bash git" }).click();
  await expect(status.getByRole("region", { name: "Input" })).toContainText('"command": "git status --short"');
  await expect(status.getByRole("region", { name: "Result" })).toContainText("M src/server/registry.ts");
  expect(resultReads).toEqual(["toolu_inline"]);

  // A sidecar result: the whole output, read from the file the record names, not the preview.
  const tests = panel.getByRole("listitem").filter({ has: dashboard.getByRole("button", { name: "bash npm" }) });
  await tests.getByRole("button", { name: "bash npm" }).click();
  const testsResult = tests.getByRole("region", { name: "Result" });
  await expect(testsResult).toContainText("all 412 tests passed");
  await expect(testsResult).toContainText("Read from the file Claude Code saved the whole output to.");
  await capture(dashboard, "tool-results");

  // Input past the live view's 1,800-character cap is shown whole.
  const write = panel.getByRole("listitem").filter({ has: dashboard.getByRole("button", { name: "write notes.md" }) });
  await write.getByRole("button", { name: "write notes.md" }).click();
  await expect(write.getByRole("region", { name: "Input" })).toContainText(LONG_TAIL);

  // A sidecar no record names stays unreachable: the call shows its result as unavailable.
  const orphan = panel.getByRole("listitem").filter({ has: dashboard.getByRole("button", { name: "bash sleep" }) });
  await orphan.getByRole("button", { name: "bash sleep" }).click();
  await expect(orphan.getByRole("region", { name: "Result" })).toContainText("Result unavailable: no result is recorded for this tool call");
  await expect(orphan).not.toContainText("an output no record names");
  await capture(dashboard, "tool-result-unavailable");

  // Closing a call and opening it again does not read its result twice.
  await status.getByRole("button", { name: "bash git" }).click();
  await expect(status.getByRole("region", { name: "Result" })).toHaveCount(0);
  await status.getByRole("button", { name: "bash git" }).click();
  await expect(status.getByRole("region", { name: "Result" })).toContainText("M src/server/registry.ts");
  expect(resultReads.filter((id) => id === "toolu_inline")).toHaveLength(1);

  // The compaction boundary, and the summary carried past it drawn as the agent's, not the operator's.
  const boundary = panel.getByRole("separator", { name: "Context compacted" });
  await expect(boundary).toContainText(/Context compacted \(auto · 167.000 tokens before\)/);
  await boundary.scrollIntoViewIfNeeded();
  await capture(dashboard, "compaction");
  await panel.getByText("Summary carried past the compaction").click();
  await expect(panel.getByText("Earlier: the checks ran and one test failed.")).toBeVisible();
  await expect(panel.getByRole("article", { name: /^you$/i }).filter({ hasText: "Run the checks and fix what fails" })).toHaveCount(1);
  await expect(panel.getByRole("article", { name: /^you$/i }).filter({ hasText: "Earlier: the checks ran" })).toHaveCount(0);

  // A subagent run opens its own transcript in place, and pages it.
  const runs = panel.getByRole("region", { name: "Subagent runs" });
  await runs.getByRole("button", { name: "Explore: Find the retry loop" }).click();
  const run = runs.getByRole("region", { name: "Subagent transcript: Explore: Find the retry loop" });
  await expect(run.getByText("Subagent question 000", { exact: true })).toBeVisible();
  await expect(run.getByText(`Subagent question ${SUBAGENT_PAIRS - 1}`, { exact: true })).toHaveCount(0);
  // Its prompts came from the parent session, never from the operator.
  await expect(run.getByRole("article").first()).toHaveAccessibleName(/^Delegated session from claude$/i);
  await expect(run.getByRole("article", { name: /^you$/i })).toHaveCount(0);
  await capture(dashboard, "subagent-run");
  await run.getByRole("button", { name: "Load more subagent messages" }).click();
  await expect(run.getByText(`Subagent question ${SUBAGENT_PAIRS - 1}`, { exact: true })).toBeVisible();
  await expect(run.getByRole("button", { name: "Load more subagent messages" })).toHaveCount(0);
  await expect(run.getByRole("article")).toHaveCount(SUBAGENT_PAIRS * 2);
  // The parent conversation is still there, below the run.
  await expect(panel.getByText("All fixed.")).toBeVisible();
});
