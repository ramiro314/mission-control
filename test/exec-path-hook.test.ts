import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { refreshProcessPathFromLoginShell, run } from "../src/server/util/exec.ts";
import { removeFakeExecutable, writeFakeExecutable } from "./helpers/fake-executable.ts";
import { withProcessEnv } from "./helpers/process-env.ts";

function script(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  return writeFakeExecutable(path, body);
}

/**
 * Starts the hook named by its first argument the way `/usr/bin/env` would: the interpreter
 * its `#!/usr/bin/env <name>` line names is looked up by bare name on this process's PATH,
 * which is the PATH `run` handed it. Spawning the hook directly would leave that lookup to
 * the kernel, and win32 starts nothing by shebang.
 */
const HOOK_RUNNER = `const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const hook = process.argv[2];
const interpreter = /^#!\\/usr\\/bin\\/env (\\S+)/.exec(readFileSync(hook, "utf8"))[1];
const result = spawnSync(interpreter, [hook], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;

test("run passes manager precedence through to child hooks with env shebangs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-hook-path-"));
  // A unique interpreter name models the system Ruby collision without running host Ruby.
  const interpreter = "mission-test-hook-runtime";
  const inherited = join(root, "system-bin");
  script(
    join(inherited, interpreter),
    'process.stderr.write("system runtime has no hook gems");\nprocess.exit(64);\n',
  );
  const runner = script(join(root, "hook-runner"), HOOK_RUNNER);
  // The hook is data the runner reads, not a fake: only its shebang line matters.
  const hook = join(root, "post-checkout");
  writeFileSync(hook, `#!/usr/bin/env ${interpreter}\n`);
  try {
    await withProcessEnv({
      HOME: root,
      // Node's own directory last, after every directory the test is about, so the Node.js
      // fakes can start under their own `#!/usr/bin/env node`.
      PATH: [inherited, "/usr/bin", "/bin", "/usr/sbin", "/sbin", dirname(process.execPath)].join(delimiter),
      SHELL: join(root, "missing-login-shell"),
      MISSION_EXECUTABLE_PATHS: undefined,
      FLEET_EXECUTABLE_PATHS: undefined,
      HARNESS_EXECUTABLE_PATHS: undefined,
      XDG_DATA_HOME: undefined,
      MISE_DATA_DIR: undefined,
      MISE_SHIMS_DIR: undefined,
      ASDF_DATA_DIR: undefined,
      VOLTA_HOME: undefined,
    }, async () => {
      for (const location of [
        [".local", "share", "mise", "shims"],
        [".asdf", "shims"],
        [".volta", "bin"],
      ]) {
        await t.test(location.join("/"), async () => {
          const shim = join(root, ...location, interpreter);
          script(shim, 'process.stdout.write("managed runtime\\n");\n');
          try {
            await refreshProcessPathFromLoginShell({ force: true });
            const result = await run(runner, [hook], { cwd: root });
            assert.equal(result.code, 0, result.stderr);
            assert.equal(result.stdout, "managed runtime\n");
            assert.equal(result.outcomeUnknown, false);
          } finally {
            removeFakeExecutable(shim);
          }
        });
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
