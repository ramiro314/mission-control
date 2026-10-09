import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnCheckProcess } from "../src/server/workflows/check-spawn.ts";
import { checkGroupAnswers, overrideCheckGroupPlatform } from "../src/server/workflows/check-group.ts";
import { processInspector } from "../src/server/process-inspection/index.ts";
import { onPath } from "../src/server/util/exec.ts";
import { provisionNativeProcessInspection } from "./helpers/native-process-inspection.ts";
import { skipOnWin32 } from "./helpers/win32-skip.ts";

// On win32 a check's identity and its job come from the native process inspection addon.
provisionNativeProcessInspection();

// The streaming adapter, against REAL short-lived processes and no mocks.
//
// Every case here is about a claim the buffered `run()` helper cannot make: an exact count of
// dropped bytes, a tail rather than a head, stdout and stderr interleaved in arrival order, and
// a missing executable told apart from a command that ran and failed.

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mission-check-spawn-"));
  dirs.push(dir);
  return dir;
}

/**
 * Every supervisor this file created, so the suite can PROVE it left nothing behind.
 *
 * The merge criterion is "no orphan process survives the suite - assert it, do not eyeball
 * it", and a check runtime that leaks a process group is the failure that costs a pooled
 * worktree. `ps` by hand would not have caught it.
 */
const supervisors: number[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  const leaked = supervisors.filter((pid) => checkGroupAnswers(pid));
  assert.deepEqual(leaked, [], "these check process groups outlived the suite");
});

const NODE = process.execPath;

/**
 * The variables libuv adds on win32 to a child environment that lacks them, copied from the
 * parent, because Windows programs fail without them (`required_vars` in libuv's
 * `src/win/process.c`).
 */
const LIBUV_WIN32_REQUIRED_ENV = new Set([
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);
/** The argv separator in `/proc/<pid>/cmdline`, built from its code point so that no
 *  invisible byte ends up sitting in this file. */
const NUL = String.fromCharCode(0);

async function run(
  command: readonly string[],
  over: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Awaited<ReturnType<typeof spawnCheckProcess>>> {
  const outcome = await spawnCheckProcess({
    attemptId: `attempt-${supervisors.length}-${command[0]}`,
    command,
    cwd: over.cwd ?? process.cwd(),
    env: over.env ?? { PATH: process.env.PATH ?? "" },
    timeoutMs: over.timeoutMs ?? 20_000,
    maxOutputBytes: over.maxOutputBytes,
  });
  if (outcome.supervisor) supervisors.push(outcome.supervisor.pid);
  return outcome;
}

test("a command that exits 0 reports its output", async () => {
  const { result, emptiness } = await run(["sh", "-c", "echo hello"]);
  assert.deepEqual(result, { kind: "exited", exitCode: 0, output: "hello\n", truncatedBytes: 0 });
  // Proven, not assumed: the group is confirmed gone before this returns.
  assert.equal(emptiness, "empty");
});

test("a non-zero exit is `exited`, not a failure of the runtime", async () => {
  const { result } = await run(["sh", "-c", "echo nope 1>&2; exit 7"]);
  assert.deepEqual(result, { kind: "exited", exitCode: 7, output: "nope\n", truncatedBytes: 0 });
});

test("stdout and stderr share one ring, in arrival order", async () => {
  // The sleeps are what make this an assertion rather than a coin toss: without them both
  // pipes can hold data at the moment the parent is scheduled, and which one is drained first
  // says nothing about which was written first.
  const { result } = await run([
    "sh",
    "-c",
    "echo one; sleep 0.05; echo two 1>&2; sleep 0.05; echo three",
  ]);
  assert.equal(result.kind, "exited");
  assert.equal(result.kind === "exited" && result.output, "one\ntwo\nthree\n");
});

test("the tail is kept and truncatedBytes is EXACT against a known byte count", async () => {
  const total = 5_000;
  const keep = 1_000;
  const { result } = await run(
    [NODE, "-e", `process.stdout.write("x".repeat(${total - 1}) + "Z")`],
    { maxOutputBytes: keep },
  );
  assert.equal(result.kind, "exited");
  if (result.kind !== "exited") return;
  assert.equal(Buffer.byteLength(result.output), keep);
  assert.equal(result.truncatedBytes, total - keep);
  assert.equal(
    Buffer.byteLength(result.output) + result.truncatedBytes,
    total,
    "kept plus dropped must equal every byte the command wrote",
  );
  // Tail-biased, so the LAST byte is the one that survived. A head-biased clip of a build log
  // is four kilobytes of dependency resolution.
  assert.equal(result.output.endsWith("Z"), true);
});

test("a multi-byte character straddling the cut costs its bytes, and is not mangled", async () => {
  // 1,000 x U+00E9 is 2,000 bytes. Retaining 1,001 lands the cut inside a character, so the
  // ring advances past the continuation byte - and counts it as dropped, which it is.
  const { result } = await run([NODE, "-e", `process.stdout.write("\\u00e9".repeat(1000))`], {
    maxOutputBytes: 1_001,
  });
  assert.equal(result.kind, "exited");
  if (result.kind !== "exited") return;
  assert.equal(result.output, "é".repeat(500));
  assert.equal(result.truncatedBytes, 1_000);
  assert.equal(Buffer.byteLength(result.output) + result.truncatedBytes, 2_000);
  assert.equal(result.output.includes("�"), false, "no replacement character at the cut");
});

test("truncation accounting stays exact when the output is not valid UTF-8", async () => {
  // A build emits invalid UTF-8 more often than it sounds: a binary fixture echoed to stdout, a
  // terminal escape sequence, a log line cut mid-character by another writer.

  // 1. A standalone invalid byte landing exactly at the retained front. It is dropped from the
  //    output - it could never decode to anything but a replacement character - and counted as
  //    dropped, so retained + truncated still equals every byte written.
  const wrote = 50 + 1 + 9;
  const { result: cut } = await run(
    [
      NODE,
      "-e",
      'process.stdout.write(Buffer.concat([Buffer.from("z".repeat(50)), Buffer.from([0x80]), Buffer.from("y".repeat(9))]))',
    ],
    { maxOutputBytes: 10 },
  );
  assert.equal(cut.kind, "exited");
  if (cut.kind !== "exited") return;
  assert.equal(cut.output, "y".repeat(9), "the ambiguous byte is not shown");
  assert.equal(Buffer.byteLength(cut.output) + cut.truncatedBytes, wrote, "and it is counted as dropped");
  assert.equal(cut.output.includes("�"), false);

  // 2. No truncation at all, one stray byte inside. NOTHING was dropped, and the count says so -
  //    but the DECODED string is longer than what was written, because U+FFFD is three bytes
  //    where one was. This is the case where `byteLength(output) + truncatedBytes` overshoots,
  //    and it is a property of decoding rather than of the accounting.
  const { result: whole } = await run([
    NODE,
    "-e",
    'process.stdout.write(Buffer.concat([Buffer.from("a".repeat(10)), Buffer.from([0x80])]))',
  ]);
  assert.equal(whole.kind, "exited");
  if (whole.kind !== "exited") return;
  assert.equal(whole.truncatedBytes, 0, "nothing was dropped, so nothing may be reported as dropped");
  assert.equal(whole.output, `${"a".repeat(10)}�`);
  assert.equal(Buffer.byteLength(whole.output), 13, "11 bytes written decode to 13 - the stated caveat");
});

test("a missing executable is `unavailable`, and nothing else here is", async () => {
  const { result } = await run(["mission-control-no-such-binary"]);
  assert.equal(result.kind, "unavailable");
  assert.match(result.kind === "unavailable" ? result.note : "", /was not found/);
});

test("a relative ./script in the working directory is found - the onPath trap", async () => {
  const dir = workspace();
  // win32 starts only executables, never a `#!` script, so there the relative command is a copy
  // of this runtime under a name nothing else has. Either way it exists only in `dir`.
  const command =
    process.platform === "win32"
      ? ["./check.exe", "-e", "process.stdout.write('ran-relative' + String.fromCharCode(10))"]
      : ["./check"];
  if (process.platform === "win32") {
    copyFileSync(NODE, join(dir, "check.exe"));
  } else {
    writeFileSync(join(dir, "check"), "#!/bin/sh\necho ran-relative\n");
    chmodSync(join(dir, "check"), 0o755);
  }

  // The trap itself, asserted rather than described: `onPath` answers this question against
  // the DAEMON's cwd, so it calls a script that plainly exists "missing". Anything that
  // prechecked a check command with it would refuse to run `./scripts/check` and
  // `node_modules/.bin/tsc` in every repository on the machine.
  assert.equal(onPath(command[0]!), false, "onPath resolves relative names against the wrong directory");

  const { result } = await run(command, { cwd: dir });
  assert.deepEqual(result, {
    kind: "exited",
    exitCode: 0,
    output: "ran-relative\n",
    truncatedBytes: 0,
  });
});

test("a timeout is infrastructure, never a non-zero exit", async () => {
  const { result, emptiness } = await run(["sh", "-c", "sleep 30"], { timeoutMs: 400 });
  assert.equal(result.kind, "infrastructure");
  const reason = result.kind === "infrastructure" ? result.reason : "";
  assert.ok(
    reason ===
      "the check command did not finish within 400ms and its process group was terminated" ||
      reason === "the check supervisor did not start within the command's 400ms timeout",
    `unexpected timeout reason: ${reason}`,
  );
  // And the tree is provably safe to hand back afterwards.
  assert.equal(emptiness, "empty");
});

test("a command killed by a signal is infrastructure, never a fail", {
  skip: skipOnWin32(
    "win32 has no signals: a process ended by TerminateProcess reports only the exit code its killer chose",
  ),
}, async () => {
  const { result } = await run([NODE, "-e", "process.kill(process.pid, 'SIGKILL')"]);
  assert.equal(result.kind, "infrastructure");
  assert.match(result.kind === "infrastructure" ? result.reason : "", /killed by SIGKILL/);
});

test("shell: false - metacharacters are literal arguments, not syntax", async () => {
  const args = ["a;b", "$(id -u)", "x && y", "`whoami`", "*", "|", ">out.txt"];
  const { result } = await run([
    NODE,
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    ...args,
  ]);
  assert.equal(result.kind, "exited");
  // If any shell were involved, `$(id -u)` would be a number and `*` would be a file listing.
  assert.deepEqual(JSON.parse(result.kind === "exited" ? result.output : "[]"), args);
});

test("the command inherits the handed environment and nothing of the daemon's", async () => {
  process.env.MISSION_CHECK_SPAWN_SENTINEL = "the daemon's own environment";
  try {
    const handed = { PATH: process.env.PATH ?? "", KEPT: "1" };
    const { result } = await run(
      [NODE, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"],
      { env: handed },
    );
    assert.equal(result.kind, "exited");
    const seen = JSON.parse(result.kind === "exited" ? result.output : "[]") as string[];
    // `__CF_USER_TEXT_ENCODING` is added by CoreFoundation to every process macOS starts, and on
    // win32 libuv copies the variables Windows programs cannot start without from the parent
    // into any environment that lacks them, so "exactly the handed set" is not a claim any spawn
    // on either platform can make. Filtering them names the platform quirk rather than
    // weakening the assertion to a subset check.
    const platformAdded = (name: string): boolean =>
      name.startsWith("__CF") ||
      (process.platform === "win32" && LIBUV_WIN32_REQUIRED_ENV.has(name.toUpperCase()) && !Object.hasOwn(handed, name));
    assert.deepEqual(seen.filter((name) => !platformAdded(name)), ["KEPT", "PATH"]);
    assert.equal(
      seen.includes("MISSION_CHECK_SPAWN_SENTINEL"),
      false,
      "the child gets what it was handed, not what the daemon happens to be carrying",
    );
  } finally {
    delete process.env.MISSION_CHECK_SPAWN_SENTINEL;
  }
});

test("stdin is closed, so a command that reads it fails rather than hanging", async () => {
  const { result } = await run([
    NODE,
    "-e",
    "const b=require('node:fs').readFileSync(0,'utf8'); process.stdout.write('read:'+JSON.stringify(b))",
  ]);
  // The point is that it ANSWERS - quickly - instead of blocking until the timeout.
  assert.equal(result.kind, "exited");
  assert.equal(result.kind === "exited" && result.output, 'read:""');
});

/**
 * Every process whose command line carries this attempt id.
 *
 * The attempt id is in the supervisor's argv so that ITS identity is unique, and that makes it
 * the one reliable way a test can ask "is a supervisor of mine still out there" without being
 * handed a pid.
 *
 * Reads `/proc` directly on Linux rather than shelling out, because a slim container image has
 * no `ps` - the production code has the same split for the same reason, and a test helper that
 * needed a binary the code under test does not would fail on images where the subject works
 * perfectly. `-ww` on the macOS side because it otherwise clips the line, and the id sits after
 * the shim's own source in the argv. win32 has no `ps` of its own, and the one Git Bash ships
 * lists only its own processes, so it asks process inspection, as the daemon does.
 */
async function processesCarrying(attemptId: string): Promise<string[]> {
  if (process.platform === "win32") {
    const table = await processInspector().listProcesses();
    assert.equal(table.failure, null, table.failure?.stderr);
    return table.rows.filter((row) => row.command.includes(attemptId)).map((row) => `${row.pid} ${row.command}`);
  }
  if (process.platform === "linux") {
    const found: string[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll(NUL, " ");
        if (cmdline.includes(attemptId)) found.push(`${entry} ${cmdline}`);
      } catch {
        // the process exited between the listing and the read
      }
    }
    return found;
  }
  const out = execFileSync("ps", ["-ww", "-eo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split("\n").filter((line) => line.includes(attemptId));
}

test("a timeout before the supervisor is ready leaves no held shim behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-check-spawn-"));
  dirs.push(dir);
  const marker = join(dir, "branch-ran");
  const attemptId = `attempt-early-timeout-${process.pid}`;

  // 1ms: the run timer fires long before `node` can start and report readiness, so the gate is
  // still HELD when the command's own timeout expires. That path has no process group to tear
  // down - nothing was released - so it has to abort the shim directly. Getting this wrong
  // returns a tidy-looking `empty` while leaving a detached supervisor waiting on its gate
  // forever, registered with nothing and owned by nobody.
  const outcome = await spawnCheckProcess({
    attemptId,
    command: ["sh", "-c", 'touch "$1"', "sh", marker],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 1,
  });

  assert.equal(outcome.result.kind, "infrastructure");
  assert.equal(outcome.supervisor, null, "the gate never opened, so there is no owner to report");
  assert.equal(existsSync(marker), false, "and no branch code may run");
  assert.deepEqual(
    await processesCarrying(attemptId),
    [],
    "a supervisor was left holding its gate after the call returned",
  );
});

test("an unusable working directory is infrastructure, not a missing executable", async () => {
  // The distinction the shim buys: a bad cwd fails the SUPERVISOR's spawn, while a missing
  // command fails the shim's. Spawned directly, both arrive as ENOENT and a missing directory
  // would be reported to the operator as a command they never mistyped.
  const { result, supervisor } = await run(["sh", "-c", "echo hi"], {
    cwd: join(tmpdir(), "mission-check-spawn-does-not-exist"),
  });
  assert.equal(result.kind, "infrastructure");
  assert.equal(supervisor, null, "nothing ran, so there is no owner to record");
});

test("a supervisor its check group refuses starts nothing, and leaves no held shim behind", async (t) => {
  const dir = workspace();
  const marker = join(dir, "branch-ran");
  const attemptId = `attempt-group-refused-${process.pid}`;
  const abandoned: number[] = [];
  // The win32 shape is a job that will not take the supervisor; forced here so every platform
  // drives the spawner's reaction to it.
  overrideCheckGroupPlatform((platform) => ({
    ...platform,
    establish: () => "the check supervisor could not be placed in a job object: AssignProcessToJobObject failed with code 5",
    abandon: (pid) => {
      abandoned.push(pid);
      platform.abandon(pid);
    },
  }));
  t.after(() => overrideCheckGroupPlatform(null));

  const outcome = await spawnCheckProcess({
    attemptId,
    command: [NODE, "-e", "require('node:fs').writeFileSync(process.argv[1], '')", marker],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 20_000,
    onSupervisorReady: () => assert.fail("an owner was persisted for a supervisor outside its group"),
  });

  assert.deepEqual(outcome.result, {
    kind: "infrastructure",
    reason:
      "the check supervisor could not be placed in a job object: AssignProcessToJobObject failed with code 5, "
      + "so it could not be proven finished afterwards and no command was started",
  });
  assert.equal(outcome.supervisor, null, "the gate never opened, so there is no owner to report");
  assert.equal(existsSync(marker), false, "and no branch code may run");
  assert.deepEqual(abandoned, [], "no group was established, so there is none to give up");
  assert.deepEqual(await processesCarrying(attemptId), [], "a supervisor was left holding its gate");
});

test("a supervisor abandoned after its group was established gives the group up", async (t) => {
  const dir = workspace();
  const marker = join(dir, "branch-ran");
  const attemptId = `attempt-group-abandoned-${process.pid}`;
  const established: number[] = [];
  const abandoned: number[] = [];
  // The real mechanisms, observed: a job on win32, nothing to hold on POSIX.
  overrideCheckGroupPlatform((platform) => ({
    ...platform,
    establish: (pid) => {
      const refused = platform.establish(pid);
      if (refused === null) established.push(pid);
      return refused;
    },
    abandon: (pid) => {
      abandoned.push(pid);
      platform.abandon(pid);
    },
  }));
  t.after(() => overrideCheckGroupPlatform(null));

  const outcome = await spawnCheckProcess({
    attemptId,
    command: [NODE, "-e", "require('node:fs').writeFileSync(process.argv[1], '')", marker],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 20_000,
    onSupervisorReady: () => {
      throw new Error("the durable write failed");
    },
  });

  assert.equal(outcome.result.kind, "infrastructure");
  assert.match(outcome.result.kind === "infrastructure" ? outcome.result.reason : "", /could not be persisted/);
  assert.equal(outcome.supervisor, null);
  assert.equal(existsSync(marker), false, "the gate never opened, so no branch code ran");
  assert.equal(established.length, 1, "the group was established before the persist step");
  assert.deepEqual(abandoned, established, "and given up when the attempt was abandoned");
  assert.equal(checkGroupAnswers(established[0]!), false, "nothing is left holding the group");
  assert.deepEqual(await processesCarrying(attemptId), [], "a supervisor was left holding its gate");
});
