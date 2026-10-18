import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionScopeDeps } from "../../src/server/platform/session-scope.ts";

/** An environment whose user manager `linuxScopeDeps` reads as reachable. */
export const MANAGER_ENV = {
  XDG_RUNTIME_DIR: "/run/user/1000",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
};

/**
 * Session-scope deps for Linux with a reachable manager, every executable and a probe that
 * succeeds. Each nonce is `n<k>`, counting from 0, so two launches name their scopes apart.
 */
export function linuxScopeDeps(over: Partial<SessionScopeDeps> = {}): SessionScopeDeps {
  let nonces = 0;
  return {
    platform: "linux",
    env: MANAGER_ENV,
    stateHome: "/home/op/.mission-control",
    uid: 1000,
    systemdRun: () => "/usr/bin/systemd-run",
    systemctl: () => "/usr/bin/systemctl",
    choom: () => "/usr/bin/choom",
    socketExists: (path) => path.startsWith(`${MANAGER_ENV.XDG_RUNTIME_DIR}/`),
    ownCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/mission-control.service\n",
    probeRuntime: () => ({ command: "/usr/bin/node", env: {} }),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    log: () => {},
    // The next macrotask, so the probe (all microtasks here) always beats its own timeout.
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    now: () => 0,
    nonce: () => `n${nonces++}`,
    ...over,
  };
}

/**
 * A pass-through wrapper at `dir/name`: it appends its name to `dir/calls` and execs what
 * follows its first `--`. Stands in for `systemd-run` and `choom`, which both exec in place.
 */
export function passThrough(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh\necho ${name} >> "${join(dir, "calls")}"\n` +
      `while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}
