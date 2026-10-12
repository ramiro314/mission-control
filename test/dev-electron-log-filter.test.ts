/**
 * `dev:electron` runs the Electron shell through a filter that drops Chromium's
 * `Frame latency is negative` log. On Linux under Wayland the GPU process prints it several
 * times a second (`components/viz/service/display/display.cc`, logged at ERROR when a swap
 * starts before its BeginFrame time), which buries the shell's real output.
 *
 * The shell command is taken from `package.json` and run the way `concurrently` runs it, with
 * `sh -c` and a stub `electronmon` first on `PATH`. The stub prints the noise, an unrelated
 * Chromium error, ordinary output and the dev server URL it was given, so a change to the
 * script's quoting, pipe, or environment that drops more than the one message fails here.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const shellCommand = (pkg.scripts["dev:electron"] as string).match(/"([^"]*electronmon[^"]*)"/)?.[1];

const NOISE = "[2904504:1011/171816.587641:ERROR:components/viz/service/display/display.cc:273] Frame latency is negative: -0.008 ms";
const REAL_ERROR = "[2904504:1011/171816.600000:ERROR:ui/ozone/platform/wayland/gpu/wayland_surface_factory.cc:249] a real error";

const dir = mkdtempSync(join(tmpdir(), "mission-dev-electron-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(
  join(dir, "electronmon"),
  `#!/bin/sh
echo "${NOISE}" >&2
echo "${REAL_ERROR}" >&2
echo "app stdout"
echo "${NOISE}" >&2
echo "dev server: $MISSION_DEV_SERVER_URL"
`,
);
chmodSync(join(dir, "electronmon"), 0o755);

test("dev:electron drops only Chromium's negative frame latency log", { skip: process.platform === "win32" }, () => {
  assert.ok(shellCommand, "dev:electron no longer runs electronmon as a quoted concurrently command");
  const result = spawnSync("sh", ["-c", shellCommand], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = (result.stdout + result.stderr).split("\n").filter(Boolean);
  assert.deepEqual(lines, [REAL_ERROR, "app stdout", "dev server: http://localhost:5173"]);
});
