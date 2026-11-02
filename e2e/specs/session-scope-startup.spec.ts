import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "../fixtures/test.ts";
import { scopeArgvs } from "../fixtures/records.ts";

/**
 * A starting daemon stops the session scopes a previous run of it left behind.
 *
 * Linux-only, because the session scope exists only there, and the one layer that can pin this:
 * the opt-in is a line of `src/server/index.ts`, and under the test runner the production scope
 * is inert. Nothing reaches a real systemd. The runtime directory holds listening
 * `systemd/private` and `bus` sockets, so the daemon reads a user manager as reachable, and the
 * suite's `systemctl` fake records each argv.
 */

// Short, because a Unix socket path is capped near 108 bytes.
const runtimeDir = mkdtempSync(join(tmpdir(), "mc-scope-"));
mkdirSync(join(runtimeDir, "systemd"));
const sockets: Server[] = [join(runtimeDir, "systemd", "private"), join(runtimeDir, "bus")].map((path) =>
  createServer((client) => client.end()).listen(path),
);

test.afterAll(() => {
  for (const server of sockets) server.close();
  rmSync(runtimeDir, { recursive: true, force: true });
});

test.use({ daemonEnv: { XDG_RUNTIME_DIR: runtimeDir } });

test("a daemon starting up stops its own instance's stale session scopes", async ({ daemon }) => {
  test.skip(process.platform !== "linux", "the session scope exists only on Linux");
  const instance = createHash("sha256").update(realpathSync(daemon.home)).digest("hex").slice(0, 8);
  const stops = () => scopeArgvs(daemon.recordDir, "systemctl-").filter((argv) => argv.includes("stop"));
  await expect
    .poll(stops, { message: "the daemon never asked systemd to stop its stale scopes" })
    .toEqual([["--user", "stop", "--no-block", `mission-control-${instance}-*.scope`]]);
});
