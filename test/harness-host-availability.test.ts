import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeExecutable } from "./helpers/fake-executable.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "harness-host-availability-")));
process.env.MISSION_HOME = home;
process.env.MISSION_PORT = "7317";
// One fake that prints its args like `echo`, so every agent binary resolves.
const echo = writeFakeExecutable(
  join(home, "echo"),
  'process.stdout.write(process.argv.slice(2).join(" ") + "\\n");\n',
);
process.env.MISSION_CLAUDE_BIN = echo;
process.env.MISSION_CODEX_BIN = echo;
process.env.MISSION_PI_BIN = echo;
process.env.MISSION_MCP_SERVER = join(home, "server.mjs");
writeFileSync(process.env.MISSION_MCP_SERVER, "// Only refusal is under test.\n");

const { HARNESS_CAPABILITIES, harnessUnsupportedWhy } = await import("../src/shared/harness-capabilities.ts");
const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { prepareTaskRepositories } = await import("../src/server/task-repository-preparation.ts");
const { SETUP_PROBES, defaultSetupDeps, setupProbeResult } = await import("../src/server/setup/index.ts");
type SetupDeps = import("../src/server/setup/types.ts").SetupDeps;

const roots: string[] = [home];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const REFUSED = ["codex", "pi"] as const;
const AGENT_ROW = { claude: "claude-cli", codex: "codex-cli", pi: "pi-cli" } as const;

function repo(): string {
  const fixture = mkOriginAndClone("harness-host-repo-");
  roots.push(fixture.root);
  return fixture.clone;
}

test("on win32 the registry keeps Claude Code and refuses Codex and Pi with a stated reason", () => {
  assert.equal(harnessUnsupportedWhy("claude", "win32"), null);
  assert.equal(
    harnessUnsupportedWhy("codex", "win32"),
    "Mission Control does not support Codex on Windows yet, so Codex tasks cannot be dispatched on this machine.",
  );
  assert.equal(
    harnessUnsupportedWhy("pi", "win32"),
    "Mission Control does not support Pi on Windows yet, so Pi tasks cannot be dispatched on this machine.",
  );
});

test("macOS and Linux availability is unchanged: no harness names either host", () => {
  for (const agent of Object.keys(HARNESS_CAPABILITIES) as (keyof typeof HARNESS_CAPABILITIES)[]) {
    assert.deepEqual(
      HARNESS_CAPABILITIES[agent].unsupportedHosts.filter((host) => host !== "win32"),
      [],
      `${agent} must not be refused anywhere but win32`,
    );
    assert.equal(harnessUnsupportedWhy(agent, "darwin"), null);
    assert.equal(harnessUnsupportedWhy(agent, "linux"), null);
  }
});

function setupDeps(platform: NodeJS.Platform, probes: { count: number }): SetupDeps {
  return {
    ...defaultSetupDeps(),
    agentUnsupported: (agent) => harnessUnsupportedWhy(agent, platform),
    executableDiagnostic: async (id) => {
      probes.count++;
      return { path: `/tools/${id}`, source: "PATH" };
    },
  };
}

test("Settings > Setup shows the reason on the Codex and Pi rows on win32, before any install probe", async () => {
  const probes = { count: 0 };
  for (const agent of REFUSED) {
    const status = setupProbeResult(await SETUP_PROBES[AGENT_ROW[agent]](setupDeps("win32", probes))).status;
    assert.deepEqual(status, { state: "needs-setup", why: harnessUnsupportedWhy(agent, "win32"), evidence: null });
  }
  assert.equal(probes.count, 0, "a refused harness is never reported as installed");
  const claude = setupProbeResult(await SETUP_PROBES["claude-cli"](setupDeps("win32", probes))).status;
  assert.equal(claude.state, "satisfied");
});

test("Settings > Setup rows on macOS are unchanged", async () => {
  const probes = { count: 0 };
  for (const row of Object.values(AGENT_ROW)) {
    const status = setupProbeResult(await SETUP_PROBES[row](setupDeps("darwin", probes))).status;
    assert.equal(status.state, "satisfied", row);
  }
  assert.equal(probes.count, 3);
});

test("the daemon's own Setup deps answer for this host", () => {
  const deps = defaultSetupDeps();
  for (const agent of ["claude", ...REFUSED] as const) {
    assert.equal(deps.agentUnsupported?.(agent), harnessUnsupportedWhy(agent, process.platform));
  }
});

for (const agent of REFUSED) {
  test(`a ${agent} task is refused at creation on win32 without a worktree`, async () => {
    const clone = repo();
    const before = gitIn(clone, "worktree", "list", "--porcelain");
    const result = await prepareTaskRepositories({
      primary: clone, extras: [], agent, kind: "ship", shortNameSelectors: "none", platform: "win32",
    });
    assert.deepEqual(result, { ok: false, status: 400, error: harnessUnsupportedWhy(agent, "win32") });
    assert.equal(gitIn(clone, "worktree", "list", "--porcelain"), before);
  });

  test(`an existing ${agent} task fails with the reason on win32 before bases, worktrees, or spawn`, async () => {
    const clone = repo();
    const registry = new Registry();
    const id = `win32-${agent}`;
    registry.upsertTask(mkTask({ id, kind: "ship", agent, status: "backlog", repoRoot: clone }));
    const before = gitIn(clone, "worktree", "list", "--porcelain");
    let touched = false;
    const fail = async (): Promise<never> => { touched = true; throw new Error("resource boundary crossed"); };
    await new Dispatcher(registry, async () => {}, {
      platform: "win32",
      resolveBases: fail,
      spawn: fail,
      resolveRuntime: () => { touched = true; return "sdk"; },
    }).dispatch(id);
    const task = registry.getTask(id)!;
    assert.equal(touched, false, "the refusal precedes runtime resolution and provisioning");
    assert.equal(task.status, "failed");
    assert.equal(task.error, harnessUnsupportedWhy(agent, "win32"));
    assert.equal(task.worktreePath, null);
    assert.equal(gitIn(clone, "worktree", "list", "--porcelain"), before);
    assert.equal(existsSync(join(home, "worktrees")), false);
  });
}

test("Claude Code on win32, and every harness on macOS, pass the host refusal", async () => {
  const cases = [["claude", "win32"], ["claude", "darwin"], ["codex", "darwin"], ["pi", "darwin"]] as const;
  for (const [agent, platform] of cases) {
    const clone = repo();
    assert.equal((await prepareTaskRepositories({
      primary: clone, extras: [], agent, kind: "ship", shortNameSelectors: "none", platform,
    })).ok, true, `${agent} on ${platform} is created`);

    const registry = new Registry();
    const id = `${platform}-${agent}`;
    registry.upsertTask(mkTask({ id, kind: "ship", agent, status: "backlog", repoRoot: clone }));
    let reachedBases = false;
    await new Dispatcher(registry, async () => {}, {
      platform,
      // The terminal runtime is refused on win32 for its own reason, so Claude Code dispatches there through the SDK.
      resolveRuntime: () => platform === "win32" ? "sdk" : "terminal",
      resolveBases: async () => { reachedBases = true; throw new Error("stop at the bases"); },
    }).dispatch(id);
    assert.equal(reachedBases, true, `${agent} on ${platform}: ${registry.getTask(id)?.error}`);
  }
});
