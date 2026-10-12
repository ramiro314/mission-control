import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

const root = mkdtempSync(join(tmpdir(), "mission-agent-runtime-root-"));
process.env.HARNESS_HOME = join(root, "state");
mkdirSync(process.env.HARNESS_HOME, { recursive: true });
// Each test points the shared resolver at its own runtime base, and at its own temp dir so the
// Linux legacy root is a fixture rather than the machine's real `/tmp` one.
const originalTmpdir = process.env.TMPDIR;
const originalGetuid = process.getuid;

const runtime = await import("../src/shared/harness-runtime.mjs");
const {
  AGENT_CAPABILITIES_ROOT,
  AGENT_RUNTIME_DIR_ENV,
  AGENT_STATE_ROOT,
  AgentRuntimeRootRefusedError,
  agentRuntimeBase,
  agentRuntimeRoot,
  legacyAgentRuntimeRoot,
  sessionScoutCredentialPath,
} = runtime;
const { agentSubprocessEnv, cleanupAgentSubprocessEnv, createDisposableAgentStateHome, isolatedAgentArgv, reconcileDisposableAgentStateHomes } =
  await import("../src/server/agent-subprocess-env.ts");
const { provisionScoutSubmissionCredential, provisionSessionScoutCredential, sessionScoutCredentialLocator } =
  await import("../src/server/scouts/submission-auth.ts");
const { TerminalLaunchError } = await import("../src/server/terminal/launch-error.ts");

let serial = 0;
function fixture(): { base: string; temp: string } {
  const dir = join(root, `case-${++serial}`);
  const base = join(dir, "runtime");
  const temp = join(dir, "tmp");
  mkdirSync(temp, { recursive: true });
  process.env[AGENT_RUNTIME_DIR_ENV] = base;
  process.env.TMPDIR = temp;
  return { base, temp };
}

afterEach(() => {
  delete process.env[AGENT_RUNTIME_DIR_ENV];
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  process.getuid = originalGetuid;
});
after(() => rmSync(root, { recursive: true, force: true }));

const linuxOnly = { skip: process.platform !== "linux" ? "the legacy root exists only on Linux" : false };

test("the resolver prefers the daemon's override, then Linux XDG_RUNTIME_DIR, then the temp dir", () => {
  const xdg = { XDG_RUNTIME_DIR: "/run/user/1000" };
  assert.equal(agentRuntimeBase({ [AGENT_RUNTIME_DIR_ENV]: "/private/runtime", ...xdg }, "linux"), "/private/runtime");
  assert.equal(agentRuntimeBase({ [AGENT_RUNTIME_DIR_ENV]: "/private/runtime", ...xdg }, "darwin"), "/private/runtime");
  assert.equal(agentRuntimeBase(xdg, "linux"), "/run/user/1000/mission-control");
  assert.equal(agentRuntimeBase({}, "linux"), tmpdir());
  // macOS ignores XDG_RUNTIME_DIR: its temp dir is already per-user, so it stays where it was.
  assert.equal(agentRuntimeBase(xdg, "darwin"), tmpdir());
  assert.equal(agentRuntimeBase({}, "darwin"), tmpdir());
  assert.equal(legacyAgentRuntimeRoot(AGENT_CAPABILITIES_ROOT, "darwin"), null);
});

test("every launch env and its wrapper carry the resolved runtime base", () => {
  const { base } = fixture();
  const env = agentSubprocessEnv({ [AGENT_RUNTIME_DIR_ENV]: "/somewhere/else" }, { loopbackAccess: true, cwd: root });
  try {
    assert.equal(env[AGENT_RUNTIME_DIR_ENV], base);
    assert.ok(env.MISSION_HOME!.startsWith(join(base, AGENT_STATE_ROOT, "session-")));
    assert.ok(env.MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE!.startsWith(join(base, AGENT_CAPABILITIES_ROOT)));
  } finally {
    cleanupAgentSubprocessEnv(env);
  }
  const argv = isolatedAgentArgv(["true"]);
  const wrapper = readFileSync(argv[1]!, "utf8");
  assert.match(wrapper, new RegExp(`^export ${AGENT_RUNTIME_DIR_ENV}=.*${base}`, "m"));
  rmSync(join(argv[1]!, ".."), { recursive: true, force: true });
});

test("an MCP child given the override reads the credential the daemon wrote", () => {
  const { base } = fixture();
  const sessionId = "runtime-root-session";
  provisionSessionScoutCredential({ taskId: null, cwd: root, sessionId, episodeId: "e1", pid: 0, agentSessionId: null });
  const written = sessionScoutCredentialPath(`session:${sessionScoutCredentialLocator(sessionId)}`);
  assert.ok(written.startsWith(join(base, AGENT_CAPABILITIES_ROOT)));

  const childEnv = {
    ...agentSubprocessEnv({ PATH: process.env.PATH }, { loopbackAccess: true }),
    // A child whose own environment would derive a different root still uses the daemon's.
    XDG_RUNTIME_DIR: join(root, "child-xdg"),
    TMPDIR: join(root, "child-tmp"),
    MISSION_SCOUT_SESSION_LOCATOR: sessionScoutCredentialLocator(sessionId),
  };
  try {
    const read = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(new URL("../src/shared/harness-runtime.mjs", import.meta.url).href)});
       process.stdout.write(m.readSessionScoutSubmissionCredential(process.cwd()));`], { env: childEnv, encoding: "utf8" });
    assert.equal(read, readFileSync(written, "utf8").trim());
    assert.ok(read.length > 0);
  } finally {
    cleanupAgentSubprocessEnv(childEnv);
  }
});

const refusal = /Mission Control refused .+: (a symlink )?owned by uid \d+ with mode \d{4}; remove it and retry$/;

test("a root owned by another uid is refused with the named message and no fallback", () => {
  const { base } = fixture();
  mkdirSync(join(base, AGENT_STATE_ROOT), { recursive: true, mode: 0o700 });
  const uid = process.getuid!();
  process.getuid = () => uid + 1;
  assert.throws(() => agentRuntimeRoot(AGENT_STATE_ROOT, { create: true }), (error: Error) => {
    assert.ok(error instanceof AgentRuntimeRootRefusedError);
    assert.equal(error.message,
      `Mission Control refused ${join(base, AGENT_STATE_ROOT)}: owned by uid ${uid} with mode 0700; remove it and retry`);
    return true;
  });
  // The daemon's launch fails definitively through the launch-error path, nothing delivered.
  assert.throws(() => createDisposableAgentStateHome(), (error: Error) => {
    assert.ok(error instanceof TerminalLaunchError);
    assert.equal(error.outcomeUnknown, false);
    assert.match(error.message, refusal);
    return true;
  });
  assert.deepEqual(readdirSync(join(base, AGENT_STATE_ROOT)), []);
});

test("a group-writable root refuses launches and credential provisioning, and the child reads nothing", () => {
  const { base, temp } = fixture();
  const sessionId = "group-writable-session";
  provisionSessionScoutCredential({ taskId: null, cwd: root, sessionId, episodeId: "e1", pid: 0, agentSessionId: null });
  const capabilities = join(base, AGENT_CAPABILITIES_ROOT);
  chmodSync(capabilities, 0o770);

  assert.throws(() => provisionScoutSubmissionCredential("task-a", root), refusal);
  assert.throws(
    () => provisionSessionScoutCredential({ taskId: null, cwd: root, sessionId, episodeId: "e2", pid: 0, agentSessionId: null }),
    (error: Error) => error.message === `Mission Control refused ${capabilities}: owned by uid ${process.getuid!()} with mode 0770; remove it and retry`,
  );
  assert.throws(() => agentSubprocessEnv({}, { loopbackAccess: true, cwd: root }), (error: Error) =>
    error instanceof TerminalLaunchError && refusal.test(error.message));

  process.env.MISSION_SCOUT_SESSION_LOCATOR = sessionScoutCredentialLocator(sessionId);
  try {
    assert.equal(runtime.readSessionScoutSubmissionCredential(root), "");
  } finally {
    delete process.env.MISSION_SCOUT_SESSION_LOCATOR;
  }
  // Never steered elsewhere: the temp dir did not receive a substitute root.
  assert.equal(existsSync(join(temp, AGENT_CAPABILITIES_ROOT)), false);
});

test("a symlinked root is refused even when its target is private", () => {
  const { base } = fixture();
  const target = join(root, `private-target-${serial}`);
  mkdirSync(target, { mode: 0o700 });
  mkdirSync(base, { recursive: true, mode: 0o700 });
  symlinkSync(target, join(base, AGENT_STATE_ROOT));
  assert.throws(() => agentRuntimeRoot(AGENT_STATE_ROOT, { create: true }),
    /Mission Control refused .+: a symlink owned by uid \d+ with mode \d{4}; remove it and retry$/);
  assert.throws(() => createDisposableAgentStateHome(), TerminalLaunchError);
  assert.deepEqual(readdirSync(target), []);
});

test("on Linux capability files are also written to an owned legacy root", linuxOnly, () => {
  const { base, temp } = fixture();
  const legacy = join(temp, AGENT_CAPABILITIES_ROOT);
  mkdirSync(legacy, { mode: 0o700 });

  const token = provisionScoutSubmissionCredential("task-dual", root);
  const current = runtime.isolatedScoutSubmissionCredentialPath(root);
  assert.ok(current.startsWith(join(base, AGENT_CAPABILITIES_ROOT)));
  const name = current.slice(join(base, AGENT_CAPABILITIES_ROOT).length + 1);
  assert.equal(readFileSync(current, "utf8").trim(), token);
  assert.equal(readFileSync(join(legacy, name), "utf8").trim(), token);

  const paths = provisionSessionScoutCredential({ taskId: null, cwd: root, sessionId: "dual", episodeId: "e1", pid: 0, agentSessionId: null });
  assert.equal(paths.length, 2);
  assert.ok(paths[0]!.startsWith(join(base, AGENT_CAPABILITIES_ROOT)));
  assert.ok(paths[1]!.startsWith(legacy));
  assert.equal(readFileSync(paths[0]!, "utf8"), readFileSync(paths[1]!, "utf8"));
});

test("on Linux nothing is written to a legacy root that fails the ownership check", linuxOnly, () => {
  const { temp } = fixture();
  const legacy = join(temp, AGENT_CAPABILITIES_ROOT);
  mkdirSync(legacy, { mode: 0o700 });
  chmodSync(legacy, 0o777);

  provisionScoutSubmissionCredential("task-foreign", root);
  const paths = provisionSessionScoutCredential({ taskId: null, cwd: root, sessionId: "foreign", episodeId: "e1", pid: 0, agentSessionId: null });
  assert.equal(paths.length, 1);
  assert.deepEqual(readdirSync(legacy), []);
});

test("on Linux reconciliation sweeps both the current and the legacy state root", linuxOnly, () => {
  const { base, temp } = fixture();
  const expired = JSON.stringify({ expiresAt: 1 });
  const homes = [join(base, AGENT_STATE_ROOT, "session-current"), join(temp, AGENT_STATE_ROOT, "session-legacy")];
  for (const home of homes) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "pipeline-caller-x.json"), expired, { mode: 0o600 });
  }
  reconcileDisposableAgentStateHomes(Date.now());
  for (const home of homes) assert.deepEqual(readdirSync(home), [], home);
});
