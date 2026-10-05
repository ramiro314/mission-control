import assert from "node:assert/strict";
import test from "node:test";
import { processInspectorFor } from "../src/server/process-inspection/index.ts";
import {
  createPosixProcessInspector,
  posixProcessInspector,
  type CommandRunner,
} from "../src/server/process-inspection/posix.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";

interface Call {
  sync: boolean;
  bin: string;
  args: string[];
  opts: { timeoutMs: number; maxBuffer?: number };
}

/** A runner that records every command and answers from a script keyed by argv. */
function recordingRunner(answers: Record<string, RunResult | string | null> = {}) {
  const calls: Call[] = [];
  const key = (bin: string, args: string[]) => [bin, ...args].join(" ");
  const runner: CommandRunner = {
    async run(bin, args, opts) {
      calls.push({ sync: false, bin, args, opts });
      const answer = answers[key(bin, args)];
      return typeof answer === "object" && answer !== null ? answer : stubRun({ stdout: "", stderr: "", code: 0 });
    },
    runSync(bin, args, opts) {
      calls.push({ sync: true, bin, args, opts });
      const answer = answers[key(bin, args)];
      return typeof answer === "string" ? answer : null;
    },
  };
  return { runner, calls };
}

test("the POSIX inspector issues exactly the commands its call sites issued before", async () => {
  const { runner, calls } = recordingRunner();
  const inspector = createPosixProcessInspector(runner);
  await inspector.listProcesses();
  await inspector.readCwds([11, 12]);
  await inspector.readOpenFiles([21, 22]);
  inspector.readStartAndCommandSync(31);
  inspector.readStartTimeSync(41);
  await inspector.findListeningPid(4317);

  assert.deepEqual(calls, [
    // discovery/processes.ts: two system-wide passes, joined on pid.
    { sync: false, bin: "ps", args: ["-Ao", "uid=,pid=,ppid=,state=,tty=,lstart="], opts: { timeoutMs: 30_000 } },
    { sync: false, bin: "ps", args: ["-Ao", "pid=,command="], opts: { timeoutMs: 30_000 } },
    // discovery/proc-cwd.ts
    { sync: false, bin: "lsof", args: ["-a", "-d", "cwd", "-p", "11,12", "-Fpn"], opts: { timeoutMs: 30_000 } },
    // discovery/codex-rollouts.ts
    { sync: false, bin: "lsof", args: ["-a", "-p", "21,22", "-Fn"], opts: { timeoutMs: 3000, maxBuffer: 2 * 1024 * 1024 } },
    // workflows/check-identity.ts
    { sync: true, bin: "ps", args: ["-ww", "-o", "lstart=,command=", "-p", "31"], opts: { timeoutMs: 5_000, maxBuffer: 1024 * 1024 } },
    // pi/generation-lease.ts
    { sync: true, bin: "ps", args: ["-o", "lstart=", "-p", "41"], opts: { timeoutMs: 1000, maxBuffer: 4096 } },
    // New with the seam: no call site read a port's listener before.
    { sync: false, bin: "lsof", args: ["-nP", "-iTCP:4317", "-sTCP:LISTEN", "-t"], opts: { timeoutMs: 4000 } },
  ]);
});

test("the process listing joins both ps passes on pid and reports the first incomplete read", async () => {
  const failed = { ...stubRun({ stdout: "", stderr: "", code: null }), outcomeUnknown: true, childPid: 902 };
  const { runner } = recordingRunner({
    "ps -Ao uid=,pid=,ppid=,state=,tty=,lstart=": {
      ...stubRun({
        stdout: "  501   100     1 Ss   ttys001  Fri Jul  3 15:15:37 2026\n  501   200   100 Z    ??       Fri Jul 31 09:00:00 2026\n",
        stderr: "",
        code: 0,
      }),
      childPid: 901,
    },
    "ps -Ao pid=,command=": { ...failed, stdout: "  100 /bin/zsh -l\n" },
  });
  const table = await createPosixProcessInspector(runner).listProcesses();
  assert.deepEqual(table.rows, [
    { uid: 501, pid: 100, ppid: 1, state: "Ss", tty: "ttys001", start: "Fri Jul  3 15:15:37 2026", command: "/bin/zsh -l" },
    { uid: 501, pid: 200, ppid: 100, state: "Z", tty: "??", start: "Fri Jul 31 09:00:00 2026", command: "" },
  ]);
  assert.equal(table.failure?.childPid, 902);
  assert.deepEqual(table.collectorPids, [901, 902]);
});

test("lsof field records pair each path with the pid before it", async () => {
  const { runner } = recordingRunner({
    "lsof -a -d cwd -p 7,8 -Fpn": stubRun({ stdout: "p7\nfcwd\nn/work/a\np8\nfcwd\nn/work/b\n", stderr: "", code: 0 }),
    "lsof -a -p 7 -Fn": stubRun({ stdout: "p7\nn/dev/null\nn/tmp/x.jsonl\n", stderr: "", code: 0 }),
  });
  const inspector = createPosixProcessInspector(runner);
  assert.deepEqual((await inspector.readCwds([7, 8])).cwds, new Map([[7, "/work/a"], [8, "/work/b"]]));
  assert.deepEqual((await inspector.readOpenFiles([7])).files, new Map([[7, ["/dev/null", "/tmp/x.jsonl"]]]));
});

test("a start-and-command read splits the five lstart tokens from a flattened command", () => {
  const { runner } = recordingRunner({
    "ps -ww -o lstart=,command= -p 5": "Fri Jul  3 15:15:37 2026     node  -e\tshim\n",
    "ps -ww -o lstart=,command= -p 6": "Fri Jul  3 15:15:37 2026\n",
  });
  const inspector = createPosixProcessInspector(runner);
  assert.deepEqual(inspector.readStartAndCommandSync(5), { start: "Fri Jul 3 15:15:37 2026", command: "node -e shim" });
  assert.equal(inspector.readStartAndCommandSync(6), null, "a row with no command is not half an identity");
  assert.equal(inspector.readStartAndCommandSync(7), null, "an unreadable pid has no identity");
});

test("the listening pid is the first pid lsof prints, and nothing listening is null", async () => {
  const { runner } = recordingRunner({
    "lsof -nP -iTCP:80 -sTCP:LISTEN -t": stubRun({ stdout: "4242\n4243\n", stderr: "", code: 0 }),
  });
  const inspector = createPosixProcessInspector(runner);
  assert.equal(await inspector.findListeningPid(80), 4242);
  assert.equal(await inspector.findListeningPid(81), null);
});

test("no platform is registered on main, so every platform, win32 included, gets the POSIX inspector", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    assert.equal(processInspectorFor(platform), posixProcessInspector, platform);
  }
});
