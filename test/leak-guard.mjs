// Keep a test from leaving a detached process alive, in a worktree or anywhere else.
//
// The audited leak was `node -e setInterval(...)` from `test/update-build.test.ts`, alive for
// weeks with parent PID 1 and its working directory in a pool slot, which pinned that slot
// for good. It survived because its runner was killed: `t.after` never ran, and a detached
// child is in its own process group, so nothing that killed the runner reached it.
//
// So every worker gets a tag, `<worker pid>:<worker start time>`, in an environment variable
// every descendant inherits through `...process.env`, and the guard finds tagged processes by
// reading environments rather than by walking parents - a detached grandchild reparented to
// PID 1 has no parent left to walk. It has two halves, because a killed worker runs nothing:
//
//   - At worker exit, a process still carrying this worker's tag is a leak of this file. It is
//     killed, its command printed, and the file fails.
//   - At worker start, a process carrying a STALE tag - the worker PID is gone, or now belongs
//     to a process with another start time - was leaked by an earlier run whose worker died
//     before its exit half could run. It is killed and reported, but this file does not fail
//     for it. A live tag belongs to a concurrent worker and is never touched.
//
// Where this stops: a child spawned with an environment that does not carry the tag - a test
// that builds the daemon's own scrubbed launch - is invisible here, the same boundary
// AGENTS.md states for `openDb`.
//
// Plain `.mjs` with only Node built-ins, for the reason `setup-state.mjs` gives.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, writeSync } from "node:fs";

export const LEAK_TAG = "MISSION_TEST_LEAK_TAG";

const TAG_IN_ENV = new RegExp(`(?:^|\\s)${LEAK_TAG}=(\\d+:\\S+)`);

/** How long a process this file already told to stop gets to finish dying before it counts. */
const EXIT_GRACE_MS = 1_000;

/**
 * Every process this user can see: pid, parent, a start-time token, and its leak tag if any.
 * `null` when the platform offers no way to read another process's environment.
 */
export function listProcesses() {
  if (process.platform === "linux") return listFromProc();
  if (process.platform === "darwin") return listFromPs();
  return null;
}

function listFromProc() {
  const rows = [];
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  // A process in another PID namespace - a rootless container's test run, which this user can
  // read - wrote its tag with a PID that means nothing here, so every live tag of its would look
  // stale and be killed mid-run. Only processes in this worker's own namespace are judged.
  const namespace = pidNamespace("self");
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    if (namespace && pidNamespace(entry) !== namespace) continue;
    try {
      // The command name sits in parentheses and may itself contain spaces or parentheses, so
      // the fields are read from after the last one: state, ppid, ... starttime is field 22.
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const environ = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
      const tag = environ.find((pair) => pair.startsWith(`${LEAK_TAG}=`))?.slice(LEAK_TAG.length + 1) ?? null;
      rows.push({ pid: Number(entry), ppid: Number(fields[1]), start: fields[19], tag });
    } catch {
      // Exited mid-scan, or owned by another user: neither is ours to judge.
    }
  }
  return rows;
}

/** The PID namespace `/proc/<pid>` is in, or null where the kernel does not say. */
export function pidNamespace(pid) {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`);
  } catch {
    return null;
  }
}

function listFromPs() {
  // `-E` appends each process's environment to its command, for this user's processes. UTC and
  // the C locale because `lstart` is formatted text, and a tag written by a worker with one `TZ`
  // must compare equal when read by a worker with another. The tag is stripped from `ps`'s own
  // environment so the scan does not find itself.
  const env = { ...process.env, TZ: "UTC", LC_ALL: "C" };
  delete env[LEAK_TAG];
  const result = spawnSync("ps", ["-A", "-E", "-ww", "-o", "pid=,ppid=,lstart=,command="], {
    encoding: "utf8",
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const rows = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      start: match[3].replace(/\s+/g, "_"),
      tag: TAG_IN_ENV.exec(match[4])?.[1] ?? null,
      // The command with the environment appended, which is enough to recognize one.
      command: match[4],
    });
  }
  return rows;
}

/** The command line of `pid` without its environment, for a person reading the report. */
function commandOf(pid) {
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    }
    const result = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return result.stdout.trim() || "(exited)";
  } catch {
    return "(exited)";
  }
}

function killAll(rows) {
  const killed = [];
  for (const row of rows) {
    const command = commandOf(row.pid);
    try {
      process.kill(row.pid, "SIGKILL");
      killed.push({ pid: row.pid, command });
    } catch {
      // Gone between the scan and the kill, which is what was wanted.
    }
  }
  return killed;
}

function report(heading, killed) {
  const lines = killed.map(({ pid, command }) => `  pid ${pid}: ${command}`);
  writeSync(2, `${heading}\n${lines.join("\n")}\n`);
}

/** This process and every ancestor still alive, none of which a scan may kill. */
function lineage(rows) {
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  const chain = new Set();
  for (let pid = process.pid; pid > 1 && !chain.has(pid); pid = parents.get(pid) ?? 0) chain.add(pid);
  return chain;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Tag this worker, reap what earlier dead workers leaked, and fail the file at exit if it leaves
 * a tagged process of its own. Called once by `setup-state.mjs` in each test worker, with the
 * process table it already read.
 */
export function armLeakGuard(rows) {
  const self = rows?.find((row) => row.pid === process.pid);
  if (!rows || !self) return;

  // A fresh tag even when one was inherited: a worker spawned by a test (a nested `node --test`,
  // or a child simulating a worker) answers for its own descendants, and must never treat the
  // processes of the worker above it - its own ancestors among them - as its leak.
  const tag = `${process.pid}:${self.start}`;
  process.env[LEAK_TAG] = tag;

  const starts = new Map(rows.map((row) => [row.pid, row.start]));
  const protectedPids = lineage(rows);
  const stale = rows.filter((row) => {
    if (!row.tag || protectedPids.has(row.pid)) return false;
    const separator = row.tag.indexOf(":");
    const owner = Number(row.tag.slice(0, separator));
    return starts.get(owner) !== row.tag.slice(separator + 1);
  });
  const reaped = killAll(stale);
  if (reaped.length > 0) {
    report(
      `test leak guard: killed ${reaped.length} process(es) leaked by an earlier test run whose worker is gone ` +
        "(reported, not failed: the leak belongs to that run, not to this file):",
      reaped,
    );
  }

  process.on("exit", () => {
    const deadline = Date.now() + EXIT_GRACE_MS;
    let leaked = ownLeaks(tag);
    while (leaked.length > 0 && Date.now() < deadline) {
      sleep(50);
      leaked = ownLeaks(tag);
    }
    const killed = killAll(leaked);
    if (killed.length === 0) return;
    report(`test leak guard: this test file left ${killed.length} process(es) running; killed:`, killed);
    if (!process.exitCode) process.exitCode = 1;
  });
}

function ownLeaks(tag) {
  return (listProcesses() ?? []).filter(
    (row) => row.tag === tag && row.pid !== process.pid && !isLoaderService(row),
  );
}

/**
 * The compiler service `--import tsx` starts in every worker, after this guard has tagged it.
 * It is still alive when `exit` fires and is not a leak: it reads its requests from this
 * worker's pipe and exits when that closes, which is the moment this worker is gone.
 */
function isLoaderService(row) {
  return row.ppid === process.pid && /(?:^|\/)esbuild --service=/.test(row.command ?? commandOf(row.pid));
}
