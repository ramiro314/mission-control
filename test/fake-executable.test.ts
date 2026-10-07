import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

import { run } from "../src/server/util/exec.ts";
import {
  copyFakeExecutable,
  fakeExecutablePath,
  removeFakeExecutable,
  writeFakeExecutable,
} from "./helpers/fake-executable.ts";

// `test/helpers/fake-executable.ts` is how every fixture hands the product a fake CLI. These
// run its fakes through the product's own `run`, so on the Windows job they prove the win32
// launcher and on macOS and Linux they prove the shebang script, with one set of assertions.

const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-fake-executable-")));
after(() => rmSync(root, { recursive: true, force: true }));

const ECHO_ARGV = `
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env.FAKE_MARKER ?? null }));
`;

test("the returned path is the script on POSIX and its .exe launcher on win32", () => {
  assert.equal(fakeExecutablePath("/bin/fake-gh", "darwin"), "/bin/fake-gh");
  assert.equal(fakeExecutablePath("/bin/fake-gh", "linux"), "/bin/fake-gh");
  assert.equal(fakeExecutablePath("C:\\bin\\fake-gh", "win32"), "C:\\bin\\fake-gh.exe");
});

test("a fake that is not a Node.js script is refused, because it would not start on win32", () => {
  assert.throws(
    () => writeFakeExecutable(join(root, "shell-fake"), "#!/bin/sh\nexit 0\n"),
    /must be a Node\.js script.*#!\/bin\/sh/,
  );
});

test("a fake receives the exact argv, cwd and environment the product spawned it with", async () => {
  const fake = writeFakeExecutable(join(root, "argv-fake"), ECHO_ARGV);
  const argv = [
    "plain",
    "two words",
    "",
    'a "quoted" word',
    "trailing backslash\\",
    "C:\\Program Files\\Tool\\",
    "back\\\\slashes\\\"quote",
    "line one\n\nline three",
    "%PATH% & | < > ^ !",
    "{\"type\":\"object\",\"required\":[\"a b\"]}",
    "ünïcödé ✓",
  ];
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const result = await run(fake, argv, { cwd, env: { ...process.env, FAKE_MARKER: "seen" } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { argv, cwd, marker: "seen" });
});

test("a fake reads its stdin and exits with its own code", async () => {
  const fake = writeFakeExecutable(
    join(root, "stdin-fake"),
    `const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.stdout.write(Buffer.concat(chunks).toString("utf8").toUpperCase());
  process.stderr.write("refused");
  process.exit(7);
});
`,
  );
  const result = await run(fake, [], { input: "a prompt\nover two lines" });
  assert.equal(result.code, 7);
  assert.equal(result.stdout, "A PROMPT\nOVER TWO LINES");
  assert.equal(result.stderr, "refused");
});

test("a fake on PATH is found by its bare name, as the platform's ladder looks a tool up", async () => {
  const bin = join(root, "path-bin");
  mkdirSync(bin);
  const fake = writeFakeExecutable(join(bin, "mission-fake-tool"), ECHO_ARGV);
  const result = await run("mission-fake-tool", ["found"], {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).argv, ["found"]);
  assert.ok(existsSync(fake));
});

test("killing a started fake kills the script, not only what launched it", async () => {
  const pidFile = join(root, "sleeper.pid");
  const fake = writeFakeExecutable(
    join(root, "sleeper"),
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const child = spawn(fake, [], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const deadline = Date.now() + 15_000;
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) {
    assert.ok(Date.now() < deadline, "the fake never started");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const scriptPid = Number(readFileSync(pidFile, "utf8"));
  child.kill();
  await exited;
  while (isAlive(scriptPid)) {
    assert.ok(Date.now() < deadline, `the fake's script (pid ${scriptPid}) outlived the kill`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("a copied fake runs on its own, and a removed one can no longer be found", async () => {
  const original = writeFakeExecutable(join(root, "original"), ECHO_ARGV);
  const copyDir = join(root, "copy-bin");
  mkdirSync(copyDir);
  const copy = copyFakeExecutable(original, join(copyDir, "copied"));
  assert.equal(copy, fakeExecutablePath(join(copyDir, "copied")));
  const result = await run(copy, ["from the copy"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).argv, ["from the copy"]);

  removeFakeExecutable(join(copyDir, "copied"));
  const missing = await run("copied", [], {
    env: { ...process.env, PATH: `${copyDir}${delimiter}${process.env.PATH ?? ""}` },
  });
  assert.match(missing.stderr, /was not found/);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
