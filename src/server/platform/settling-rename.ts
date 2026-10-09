import { rename as fsRename, stat as fsStat } from "node:fs/promises";

// A rename that outlasts a handle someone else is about to close.
//
// win32 refuses to rename a file while another handle is open on it, and refuses to rename a
// directory while a handle is open on anything inside it, with EPERM, EACCES or EBUSY. Those
// handles are routinely brief and not ours to wait on: the virus scanner reading a file that
// was just written, or the daemon's own artifact stream still closing a response the browser
// abandoned a moment earlier. An archive delete that renamed its bundle in that window failed
// outright, and the operator was left reading an EPERM for a directory nothing was really
// using. POSIX renames regardless of open handles, so only win32 waits.
//
// The same codes also mean a refusal that waiting cannot cure - a destination that already
// exists - so each retry first checks that the destination is still absent, exactly as
// graceful-fs does for the same win32 behaviour, and a real conflict reports at once.

const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** How long a refused rename keeps trying before the refusal is reported. */
export const SETTLING_RENAME_BUDGET_MS = 5_000;

export interface SettlingRenameDeps {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  /** Resolves when `path` exists, and rejects with its errno when it does not. */
  stat?: (path: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
}

export async function settlingRename(
  from: string,
  to: string,
  deps: SettlingRenameDeps = {},
): Promise<void> {
  const rename = deps.rename ?? fsRename;
  if ((deps.platform ?? process.platform) !== "win32") return rename(from, to);
  const stat = deps.stat ?? fsStat;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.budgetMs ?? SETTLING_RENAME_BUDGET_MS);
  for (let backoff = 10; ; backoff = Math.min(backoff * 2, 200)) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (!TRANSIENT_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (now() + backoff > deadline || !(await absent(stat, to))) throw error;
      await sleep(backoff);
    }
  }
}

async function absent(stat: (path: string) => Promise<unknown>, path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
