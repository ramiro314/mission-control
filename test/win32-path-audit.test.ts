import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  cleanupDisposableAgentStateHome,
  createDisposableAgentStateHome,
  isDisposableAgentStateHome,
} from "../src/server/agent-subprocess-env.ts";
import { missionHookScriptPath } from "../src/server/harness/claude/hooks.ts";
import { reRootPath } from "../src/server/repos.ts";
import { repoLeafName } from "../src/server/testing-setup.ts";
import { grantRefusal } from "../src/shared/llm.ts";

// The win32 state-home audit's fixes in server code (M2.5 of
// `docs/plans/windows-support/plan.md`). Each one compared or split a native path on "/",
// which never matches `C:\...`. The win32 case is driven through `path.win32` or an explicit
// platform, so it runs on every platform; the POSIX case pins macOS unchanged.

const TEMP = "C:\\Users\\Ramiro\\AppData\\Local\\Temp\\mission-control-agent-state";

test("a win32 disposable agent state home is recognised, so it is cleaned up", () => {
  assert.equal(isDisposableAgentStateHome(`${TEMP}\\session-a1B2c3`, TEMP, path.win32), true);
  assert.equal(isDisposableAgentStateHome(`${TEMP}\\session-a1B2c3\\nested`, TEMP, path.win32), false);
  assert.equal(isDisposableAgentStateHome(`${TEMP}\\session-a1B2c3/nested`, TEMP, path.win32), false);
  assert.equal(isDisposableAgentStateHome(`${TEMP}\\other`, TEMP, path.win32), false);
  const posix = "/tmp/mission-control-agent-state";
  assert.equal(isDisposableAgentStateHome(`${posix}/session-a1B2c3`, posix, path.posix), true);
  assert.equal(isDisposableAgentStateHome(`${posix}/session-a1B2c3/nested`, posix, path.posix), false);
});

test("a disposable agent state home minted on this platform is removed by cleanup", () => {
  const home = createDisposableAgentStateHome();
  assert.ok(existsSync(home));
  cleanupDisposableAgentStateHome(home);
  assert.ok(!existsSync(home), home);
});

test("a win32 path inside a package keeps its subdirectory when re-rooted", () => {
  assert.equal(
    reRootPath("C:\\code\\mono", "C:\\wt\\mono-3\\packages\\web", "C:\\wt\\mono-3", path.win32),
    "C:\\code\\mono\\packages\\web",
  );
  assert.equal(reRootPath("C:\\code\\mono", "C:\\wt\\mono-3", "C:\\wt\\mono-3", path.win32), "C:\\code\\mono");
  assert.equal(reRootPath("C:\\code\\mono", "C:\\wt\\mono-30\\web", "C:\\wt\\mono-3", path.win32), "C:\\code\\mono");
  assert.equal(reRootPath("/code/mono", "/wt/mono-3/packages/web", "/wt/mono-3", path.posix), "/code/mono/packages/web");
});

test("the hook script check recognises a win32 drive path only on win32", () => {
  const script = "C:\\Users\\Ramiro\\mission-control\\hooks\\harness-hook.mjs";
  const command = `"C:\\Program Files\\nodejs\\node.exe" "${script}" Stop`;
  assert.equal(missionHookScriptPath(command, "win32"), script);
  assert.equal(missionHookScriptPath(command, "darwin"), null);
  assert.equal(missionHookScriptPath(`node ${script} Stop`, "win32"), script);
  assert.equal(missionHookScriptPath(`node /Users/r/mc/hooks/harness-hook.mjs Stop`, "darwin"), "/Users/r/mc/hooks/harness-hook.mjs");
});

test("the testing-setup task title names a win32 repository by its folder", () => {
  assert.equal(repoLeafName("C:\\code\\mono", path.win32), "mono");
  assert.equal(repoLeafName("C:\\code\\mono\\", path.win32), "mono");
  assert.equal(repoLeafName("/Users/ramiro/code/mono/", path.posix), "mono");
  assert.equal(repoLeafName("/", path.posix), "/");
});

test("a tool grant's win32 cwd is absolute on win32 and relative elsewhere", () => {
  const sandbox = { tools: ["Read"], enforcesDenyPaths: true };
  const grant = { tools: ["Read"], cwd: "C:\\code\\mono", denyPaths: [] };
  assert.equal(grantRefusal(sandbox, grant, "win32"), null);
  assert.match(grantRefusal(sandbox, grant, "darwin") ?? "", /grant cwd must be absolute/);
  assert.equal(grantRefusal(sandbox, { ...grant, cwd: "/code/mono" }, "darwin"), null);
});
