import { randomBytes } from "node:crypto";
import { link, lstat, readlink, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { binEnv, resolveBin, WEZTERM_BIN } from "./bin.ts";
import type { TerminalExec } from "./exec.ts";

export interface WeztermSocket {
  incarnation: string;
  exec: (args: string[], opts?: { input?: string; timeoutMs?: number }) => ReturnType<TerminalExec>;
}

/**
 * Let WezTerm resolve its default endpoint, with the inherited socket scrubbed. The
 * diagnostic is only an endpoint locator: its pane list is deliberately discarded.
 * Unknown diagnostics, proxy commands and filesystems without socket links fail closed.
 */
function selectedSocket(stderr: string): string | null {
  const matches = [...stderr.matchAll(/wezterm_client::client\s*> connect to Socket\(("(?:[^"\\]|\\.)*")\)/g)];
  if (matches.length !== 1) return null;
  try {
    const path: unknown = JSON.parse(matches[0]![1]!);
    return typeof path === "string" && path.startsWith("/") && !path.includes("\0") ? path : null;
  } catch { return null; }
}

/** Symlink hops followed from the reported endpoint before giving up. */
const MAX_SOCKET_LINK_HOPS = 8;

/**
 * The reported endpoint with its own symlinks followed, and nothing else resolved. WezTerm may
 * report its `default-<class>` symlink. Darwin's link() follows a symlink and Linux's does not,
 * so without this the alias pins the symlink, is not a socket, and WezTerm silently goes
 * unavailable. Each hop resolves against the link's own directory rather than through
 * `realpath`, so a symlinked parent (macOS `/var`, a symlinked HOME) is kept as written and
 * never lengthens the alias past the sockaddr_un limit.
 */
async function followSocketLinks(reported: string): Promise<string | null> {
  let path = reported;
  for (let hop = 0; hop <= MAX_SOCKET_LINK_HOPS; hop++) {
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isSymbolicLink()) return path;
    const target = await readlink(path).catch(() => null);
    if (target === null) return null;
    path = resolve(dirname(path), target);
  }
  return null;
}

/** Production budget for the endpoint locator: a native `wezterm cli list` answers well inside it. */
export const WEZTERM_LOCATOR_TIMEOUT_MS = 1000;

/**
 * A pathname check followed by a CLI call can race a mux restart. Pin the socket inode
 * with a hard link BEFORE enumerating or validating it, and keep that link until the
 * operation finishes. Rebinding the default pathname cannot retarget this link. Unix
 * WezTerm clients do not reconnect after losing their server.
 *
 * The opaque lifetime excludes ctime/nlink, which our own link changes. Birth time
 * distinguishes later inode reuse between operations; no birth time means no authority.
 * The short alias stays on the socket's filesystem and is removed on every exit path.
 */
export async function withWeztermSocket<T>(
  exec: TerminalExec,
  expected: string | undefined,
  operation: (socket: WeztermSocket) => Promise<T>,
  locatorTimeoutMs = WEZTERM_LOCATOR_TIMEOUT_MS,
): Promise<T | null> {
  const bin = resolveBin(WEZTERM_BIN);
  const env = binEnv(WEZTERM_BIN);
  const located = await exec(bin, ["cli", "--no-auto-start", "list", "--format", "json"], {
    env: { ...env, WEZTERM_LOG: "wezterm_client::client=trace" },
    timeoutMs: locatorTimeoutMs,
  });
  const selected = located.code === 0 ? selectedSocket(located.stderr) : null;
  const path = selected ? await followSocketLinks(selected) : null;
  if (!path) return null;
  // Do not lengthen an already near-limit sockaddr_un path (notably a private macOS HOME).
  // link is exclusive, so a collision refuses without altering anybody else's entry.
  const alias = join(dirname(path), randomBytes(8).toString("hex").slice(0, Math.min(16, basename(path).length)));
  let linked = false;
  try {
    const stat = await (async () => {
      try {
        await link(path, alias);
        linked = true;
        return await lstat(alias, { bigint: true });
      } catch { return null; }
    })();
    if (!stat?.isSocket() || stat.birthtimeNs <= 0n) return null;
    const incarnation = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    if (expected !== undefined && incarnation !== expected) return null;
    return await operation({
      incarnation,
      // env supplies a freshly pinned address, never the inherited WEZTERM_UNIX_SOCKET.
      // The fixed env executable keeps the locator's unconditional WezTerm scrub intact.
      exec: (args, opts = {}) => exec(FIXED_OS_EXECUTABLES.env, [
        `WEZTERM_UNIX_SOCKET=${alias}`, bin, "cli", "--no-auto-start", ...args,
      ], { ...opts, env }),
    });
  } finally {
    if (linked) await unlink(alias).catch(() => {});
  }
}
