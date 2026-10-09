import { execFileSync } from "node:child_process";

// What the host's sockets looked like when a navigation failed at the network layer.
//
// A Windows CI shard once failed `page.goto` with `net::ERR_NO_BUFFER_SPACE` on its 125th test:
// WSAENOBUFS, which win32 answers when it has no buffer or ephemeral port left for a new
// socket. Nothing local reproduced it, and the job keeps only its JUnit report, so the error
// text is the one place a diagnosis can travel. This appends the host's TCP sockets by state
// and the processes holding the most of them, which separates a leak (one process holding
// thousands) from churn (thousands in TIME_WAIT) the next time it happens.

/** Summarize `netstat -ano -p tcp` output, naming owners through `tasklist /FO CSV /NH`. */
export function summarizeWin32Sockets(netstat: string, tasklist = "", top = 5): string {
  const states = new Map<string, number>();
  const owners = new Map<string, number>();
  for (const line of netstat.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "TCP" || cols.length < 5) continue;
    const state = cols[3]!;
    const pid = cols[4]!;
    states.set(state, (states.get(state) ?? 0) + 1);
    owners.set(pid, (owners.get(pid) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const line of tasklist.split(/\r?\n/)) {
    const cols = line.match(/"([^"]*)"/g)?.map((col) => col.slice(1, -1));
    if (cols && cols.length > 1) names.set(cols[1]!, cols[0]!);
  }
  const total = [...states.values()].reduce((sum, n) => sum + n, 0);
  const byState = [...states].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(", ");
  const heaviest = [...owners].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([pid, n]) => `${names.get(pid) ?? "?"} (pid ${pid}) ${n}`).join(", ");
  return `TCP sockets: ${total} (${byState}); most held by: ${heaviest}`;
}

/** The host's socket picture, or why it could not be read. Never throws. */
export function hostSocketSummary(platform: NodeJS.Platform = process.platform): string {
  try {
    if (platform === "win32") {
      const run = (file: string, args: string[]): string =>
        execFileSync(file, args, { encoding: "utf8", timeout: 10_000, windowsHide: true });
      const netstat = run("netstat", ["-ano", "-p", "tcp"]);
      // Names are a convenience: on a host loaded enough to need this, tasklist can time out,
      // and the counts by state and pid still say what happened.
      let tasklist = "";
      try { tasklist = run("tasklist", ["/FO", "CSV", "/NH"]); } catch { /* unnamed owners */ }
      return summarizeWin32Sockets(netstat, tasklist);
    }
    return execFileSync("ss", ["-s"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (error) {
    return `socket summary unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Run a navigation, appending the host's socket picture to a network-layer failure. */
export async function withSocketDiagnostics<T>(
  navigation: () => Promise<T>,
  summary: () => string = hostSocketSummary,
): Promise<T> {
  try {
    return await navigation();
  } catch (error) {
    if (error instanceof Error && error.message.includes("net::ERR_")) {
      error.message += `\n\n${summary()}`;
    }
    throw error;
  }
}
