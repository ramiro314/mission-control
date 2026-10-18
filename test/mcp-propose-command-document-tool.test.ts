import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// `propose_command_document` through its REAL registered handler: a stdio MCP client talks to
// `src/mcp/server.ts`, which talks HTTP to a stub daemon that records every request and answers
// what each case needs. The routes behind it have their own tests; this one is about the adapter,
// which would otherwise be free to call the wrong endpoint, drop `repository`, read a refusal as
// success, or lose the preview's problems on the way back to the agent.

const home = mkdtempSync(join(tmpdir(), "mission-mcp-propose-"));
after(() => rmSync(home, { recursive: true, force: true }));

const TOKEN = "propose-tool-token";

interface Recorded {
  method: string;
  path: string;
  token: string | undefined;
  body: Record<string, unknown>;
}

type Answer = (recorded: Recorded) => { status: number; body: unknown };

async function fixture(t: TestContext, answer: Answer) {
  const requests: Recorded[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method ?? "",
        path: new URL(req.url ?? "/", "http://127.0.0.1").pathname,
        token: req.headers["x-harness-token"] as string | undefined,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      requests.push(recorded);
      const { status, body } = answer(recorded);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client({ name: "propose-tool-test", version: "1" });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    env: {
      ...process.env,
      MISSION_HOME: home,
      MISSION_API_TOKEN: TOKEN,
      MISSION_PORT: String(address.port),
      MISSION_SESSION_ID: "sdk:propose-test",
    } as Record<string, string>,
    stderr: "pipe",
  }));
  async function call(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const result = await client.callTool({ name: "propose_command_document", arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return {
      isError: Boolean(result.isError),
      text: content.filter((item) => item.type === "text").map((item) => item.text).join("\n"),
    };
  }
  return { call, requests };
}

const DOCUMENT = { version: 1, commands: { lint: [{ path: "apps/web", argv: ["yarn", "lint"] }] } };

test("a proposal reaches the proposals route with the document, the repository and the session, and the agent hears the preview", async (t) => {
  const f = await fixture(t, () => ({
    status: 200,
    body: {
      proposal: { id: "p2", repoRoot: "/repos/monorepo", proposedAt: 1 },
      replaced: "p1",
      preview: {
        repoRoot: "/repos/monorepo",
        commands: [{ slot: "lint", path: "apps/web", kind: "add", before: null, after: ["yarn", "lint"] }],
        testing: [],
        unchanged: 1,
        problems: ["lint · apps/web: no such folder in this repository"],
        basis: { commands: { lint: 1 }, testing: {} },
      },
    },
  }));

  const result = await f.call({ document: DOCUMENT, repository: "repo-02" });
  assert.equal(result.isError, false, result.text);

  const proposals = f.requests.filter((request) => request.path === "/mcp/command-documents/proposals");
  assert.equal(proposals.length, 1, "exactly one proposal request");
  const [sent] = proposals;
  assert.equal(sent!.method, "POST");
  assert.equal(sent!.token, TOKEN, "the request is authenticated with the daemon token");
  assert.deepEqual(sent!.body.document, DOCUMENT);
  assert.equal(sent!.body.repository, "repo-02", "the repository the agent named is forwarded");
  assert.equal(sent!.body.sessionId, "sdk:propose-test", "the daemon is told which session is asking");
  assert.equal(typeof sent!.body.cwd, "string");

  assert.match(result.text, /Proposed a Command document for \/repos\/monorepo, replacing the proposal that was pending there\./);
  assert.match(result.text, /makes 1 change \(1 already as proposed\)\. Nothing is applied until the human applies it\./);
  assert.match(result.text, /problems that block applying it:\n- lint · apps\/web: no such folder in this repository/);
});

test("leaving the repository out sends none, so the daemon decides from the task", async (t) => {
  const f = await fixture(t, () => ({
    status: 200,
    body: {
      proposal: { id: "p1", repoRoot: "/repos/app", proposedAt: 1 },
      replaced: null,
      preview: { repoRoot: "/repos/app", commands: [], testing: [], unchanged: 1, problems: [], basis: { commands: {}, testing: {} } },
    },
  }));
  const result = await f.call({ document: DOCUMENT });
  assert.equal(result.isError, false, result.text);
  assert.equal("repository" in f.requests.at(-1)!.body, false);
  assert.match(result.text, /Proposed a Command document for \/repos\/app\.\n/);
  assert.doesNotMatch(result.text, /problems/);
});

test("a daemon refusal is an error result that carries the status and the daemon's reason", async (t) => {
  const f = await fixture(t, () => ({
    status: 403,
    body: { error: "/repos/other is not one of this task's repositories.", code: "command_document_proposal_refused" },
  }));
  const result = await f.call({ document: DOCUMENT, repository: "/repos/other" });
  assert.equal(result.isError, true);
  assert.match(result.text, /^Mission Control refused the proposed Command document \(403\): /);
  assert.match(result.text, /command_document_proposal_refused/);
  assert.match(result.text, /is not one of this task's repositories/);
});
