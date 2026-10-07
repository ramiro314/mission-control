import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { skipOnWin32 } from "./helpers/win32-skip.ts";

const PI = { skip: skipOnWin32("Pi is unavailable on win32") };

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-tools-dispatch-")));
process.env.MISSION_HOME = home;
process.env.MISSION_PI_EXTENSION = join(home, "missing-extension.js");
process.env.MISSION_PORT = "7317";
process.env.MISSION_PRODUCT_ISSUE_CLIENT = "browser";
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_CODEX_BIN = "/bin/echo";
process.env.MISSION_PI_BIN = "/bin/echo";
process.env.MISSION_MCP_SERVER = join(home, "server.mjs");
process.env.MISSION_CODEX_HOOK = join(home, "codex-hook.mjs");
writeFileSync(process.env.MISSION_CODEX_HOOK, "// Registration fixture.\n");
writeFileSync(process.env.MISSION_MCP_SERVER, "// Only registration is under test.\n");

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { prepareTaskRepositories } = await import("../src/server/task-repository-preparation.ts");
const { missionToolsAvailability } = await import("../src/server/mission-tools.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const roots: string[] = [home];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function repo() {
  const fixture = mkOriginAndClone("mission-tools-repo-");
  roots.push(fixture.root);
  return fixture.clone;
}

for (const kind of ["plan", "scout"] as const) {
  test(`Pi ${kind} is refused at preparation without a worktree`, PI, async () => {
    const clone = repo();
    const before = gitIn(clone, "worktree", "list", "--porcelain");
    const result = await prepareTaskRepositories({
      primary: clone, extras: [], agent: "pi", kind, shortNameSelectors: "none",
    });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("Pi tools are unavailable");
    assert.equal(result.status, 400);
    assert.match(result.error, /integration for Pi is not installed/);
    assert.doesNotMatch(result.error, /bundle|npm run build/);
    assert.equal(gitIn(clone, "worktree", "list", "--porcelain"), before);
    assert.equal(existsSync(join(home, "worktrees")), false);
  });
}

for (const kind of ["plan", "scout", "ship"] as const) {
  test(`existing Pi ${kind} fails visibly before bases, leases, or spawn`, PI, async () => {
    const clone = repo();
    const registry = new Registry();
    const id = `pi-${kind}`;
    registry.upsertTask(mkTask({ id, kind, agent: "pi", status: "backlog", repoRoot: clone }));
    const before = gitIn(clone, "worktree", "list", "--porcelain");
    let touched = false;
    const fail = async (): Promise<never> => { touched = true; throw new Error("resource boundary crossed"); };
    await new Dispatcher(registry, async (task) => { assert.equal(task.worktreePath, null); }, { resolveBases: fail, spawn: fail }).dispatch(id,
      kind === "ship" ? { missionMcp: { tools: ["submit_ensemble_result"] } } : {},
    );
    const task = registry.getTask(id)!;
    assert.equal(touched, false, "refusal must precede provisioning, not acquire and clean it up afterwards");
    assert.equal(task.status, "failed");
    assert.match(task.error!, /integration for Pi is not installed/);
    assert.doesNotMatch(task.error!, /bundle|npm run build/);
    assert.equal(task.worktreePath, null);
    assert.equal(gitIn(clone, "worktree", "list", "--porcelain"), before);
    assert.equal(existsSync(join(home, "worktrees")), false);
  });
}

test("one machine probe can satisfy availability without changing Pi's MCP client", PI, async () => {
  let calls = 0;
  assert.deepEqual(await missionToolsAvailability("pi", () => { calls++; return true; }), {
    available: true, reason: null,
  });
  assert.equal(calls, 1);
  assert.equal((await missionToolsAvailability("pi")).available, false);
  for (const agent of ["claude", "codex"] as const) {
    assert.equal((await missionToolsAvailability(agent, () => { throw new Error("not machine scoped"); })).available, true);
  }
  assert.equal((await prepareTaskRepositories({
    primary: repo(), extras: [], agent: "pi", kind: "ship", shortNameSelectors: "none",
  })).ok, true);
});

for (const agent of ["claude", "codex"] as const) {
  test(`${agent} dispatch argv is byte-identical to the pre-capability baseline`, { skip: skipOnWin32(agent === "codex" ? "Codex is unavailable on win32" : "the terminal runtime is unavailable on win32") }, async () => {
    const clone = repo();
    setHarnessesConfig({ autoModeOnDispatch: true });
    const registry = new Registry();
    const id = `argv-${agent}`;
    registry.upsertTask(mkTask({ id, agent, repoRoot: clone, title: "Argv contract" }));
    const captured: { argv: string[] | null } = { argv: null };
    await new Dispatcher(registry, async () => {}, {
      resolveRuntime: () => "terminal",
      verifyMissionMcpTools: async () => ({ ok: true }),
      spawn: async (_label, _short, _cwd, _bin, args) => {
        captured.argv = [...args!];
        throw new Error("captured at the spawn boundary");
      },
    }).dispatch(id, { missionMcp: { tools: ["request_input", "submit_ensemble_result"] } });
    const argv = captured.argv;
    assert.ok(argv, registry.getTask(id)?.error ?? "spawn must receive argv");
    // Captured from dispatcher.ts at cc709c01, before this capability change. Only
    // machine paths, the inherited PATH and temporary credential locations vary.
    // Every flag, other value, ordering and escaped byte is pinned.
    const stable = argv.map((arg) => arg
      .replace(/"PATH"="[^"]*"/, '"PATH"="<PATH>"')
      .replace(/"MISSION_HOME"="[^"]*"/, '"MISSION_HOME"="<AGENT_HOME>"')
      .replace(/"MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE"="[^"]*"/,
        '"MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE"="<CREDENTIAL_FILE>"'));
    const serialized = JSON.stringify(stable, null, 2)
      .replaceAll(home, "<STATE_HOME>")
      .replaceAll(process.cwd(), "<CHECKOUT>")
      .replaceAll(process.execPath, "<NODE>");
    const fixture = new URL(`./fixtures/mission-tools-${agent}-argv.json`, import.meta.url);
    assert.equal(serialized + "\n", readFileSync(fixture, "utf8"));
  });
}

test("workflow-required evidence is refused early, while one successful probe reaches Pi's launch", PI, async () => {
  const clone = repo();
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "workflow-pi", agent: "pi", repoRoot: clone }));
  let bases = 0;
  await new Dispatcher(registry, async () => {}, {
    workflowEvidenceEnabled: () => true,
    resolveBases: async () => { bases++; throw new Error("too late"); },
  }).dispatch("workflow-pi");
  assert.equal(bases, 0);
  assert.match(registry.getTask("workflow-pi")!.error!, /integration for Pi is not installed/);

  registry.upsertTask(mkTask({ id: "installed-pi", agent: "pi", repoRoot: clone }));
  let probes = 0;
  let verified = 0;
  let spawned = false;
  await new Dispatcher(registry, async () => {}, {
    piExtensionInstalled: async () => { probes++; return true; },
    verifyMissionMcpTools: async () => { verified++; return { ok: true }; },
    spawn: async () => { spawned = true; throw new Error("captured Pi launch"); },
  }).dispatch("installed-pi", { missionMcp: { tools: ["request_input"] } });
  assert.equal(probes, 1, "preparation and launch must use one installation reading");
  assert.equal(verified, 1, "an extension still owes the existing bundle tool check");
  assert.equal(spawned, true, registry.getTask("installed-pi")!.error!);
});

test("a tickets follow-up's launch is granted complete_shape_tickets, and another shape launch is not", async () => {
  const { reserveShapeTicketFollowup } = await import("../src/server/db.ts");
  const { COMPLETE_SHAPE_TICKETS_TOOL } = await import("../src/server/plans/tools.ts");
  const clone = repo();
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "launch-followup", kind: "shape", agent: "claude", status: "backlog", repoRoot: clone }));
  registry.upsertTask(mkTask({ id: "launch-shaping", kind: "shape", agent: "claude", status: "backlog", repoRoot: clone }));
  reserveShapeTicketFollowup({
    followupTaskId: "launch-followup",
    sourceTaskId: "launch-source",
    sourceEpisodeId: "launch-episode",
    sourceSessionId: "launch-session",
    sourcePrUrl: "https://github.com/acme/demo/pull/7",
    now: 1,
  });

  // The launch's resolved tool list, read at the published-tools check, which is the last
  // stop before the agent is started. Stopping there keeps the test off any real process.
  // The Agent SDK runtime, which every host runs; the grant is the same on both runtimes.
  const launched = async (id: string): Promise<string[]> => {
    let tools: string[] | null = null;
    await new Dispatcher(registry, async () => {}, {
      resolveRuntime: () => "sdk",
      supervisor: {
        start: async () => assert.fail("the tools check must stop the launch"),
        stop: async () => {},
        taskLiveness: () => null,
      } as never,
      missionMcpDescriptor: async () => ({
        serverName: "mission-control",
        command: process.execPath,
        args: [join(home, "server.mjs")],
        env: {},
      }),
      planSkills: () => ({ ok: true, commands: { grill: "/grill", htmlPlans: "/html-plans", tickets: "/tickets" } }),
      verifyMissionMcpTools: async (requested) => {
        tools = [...requested];
        return { ok: false, reason: "captured at the published-tools check" };
      },
    }).dispatch(id);
    assert.ok(tools, registry.getTask(id)?.error ?? "the launch must reach the tools check");
    return tools;
  };

  const followupTools = await launched("launch-followup");
  assert.ok(followupTools.includes(COMPLETE_SHAPE_TICKETS_TOOL), followupTools.join(", "));
  const shapingTools = await launched("launch-shaping");
  assert.ok(!shapingTools.includes(COMPLETE_SHAPE_TICKETS_TOOL), shapingTools.join(", "));
  assert.ok(shapingTools.includes("request_plan_decisions"), "both are shape launches");
});
