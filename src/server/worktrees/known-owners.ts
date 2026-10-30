import { AGENT_IDENTITY } from "@shared/agent.ts";
import type { ProcessSession } from "@shared/storage-health.ts";
import type { Session } from "@shared/types.ts";
import { backgroundAgentOf, type Proc } from "../discovery/processes.ts";
import { getSdkSessionProcess, type SdkProcessLifetime } from "../sdk/store.ts";

/** One live session's own process, as PID and start time, so a reused PID is never its. */
export interface SessionProcess extends SdkProcessLifetime, ProcessSession {}

/** What one occupant is: the words a card shows, and the live session behind them, if any. */
export interface KnownOwner {
  label: string;
  session?: ProcessSession;
}

const JETBRAINS = "JetBrains IDE helper";
const VS_CODE = "VS Code helper";
const CURSOR = "Cursor helper";
const LANGUAGE_SERVER = "IDE language server";

/** IDE helpers by executable name. Each is matched on its own, never on what it descends from. */
const IDE_HELPERS: ReadonlyMap<string, string> = new Map([
  ["fsnotifier", JETBRAINS],
  ["idea", JETBRAINS],
  ["webstorm", JETBRAINS],
  ["pycharm", JETBRAINS],
  ["goland", JETBRAINS],
  ["code", VS_CODE],
  ["code-server", VS_CODE],
  ["Code Helper", VS_CODE],
  ["Code Helper (Plugin)", VS_CODE],
  ["cursor", CURSOR],
  ["Cursor Helper", CURSOR],
  ["Cursor Helper (Plugin)", CURSOR],
  ["gopls", LANGUAGE_SERVER],
  ["rust-analyzer", LANGUAGE_SERVER],
  ["clangd", LANGUAGE_SERVER],
]);

/**
 * `ps` prints argv unquoted, so an executable inside a macOS bundle reads as several words:
 * `.../Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility`.
 */
function executableName(command: string): string {
  const bundled = /^\/.*?\.app\/Contents\/MacOS\/(.+?)(?= -|$)/.exec(command);
  return bundled?.[1] ?? (command.split(/\s+/, 1)[0] ?? "").replace(/.*\//, "");
}

/**
 * The processes the live sessions are. A terminal session's `startedAt` is its process's start;
 * an SDK session's is its registration time, so its process comes from the lifetime the
 * supervisor recorded, and a driver with none has no process to name.
 */
export function sessionProcesses(
  sessions: readonly Session[],
  lifetime: (sessionId: string) => SdkProcessLifetime | null = getSdkSessionProcess,
): SessionProcess[] {
  return sessions.flatMap((session) => {
    const own = session.runtime === "sdk"
      ? lifetime(session.id)
      : { pid: session.pid, startMs: session.startedAt ?? 0 };
    return own && own.pid > 0 && own.startMs > 0 ? [{ ...own, id: session.id, name: session.name }] : [];
  });
}

/**
 * The live sessions' processes, or a throw until a discovery sweep has filled the session map.
 * Before that an empty map is no evidence that a process has no session, and Kill must not read
 * it as evidence, so the names go unread instead.
 */
export function observedSessionProcesses(
  registry: { sessionsObserved(): boolean; liveSessions(): Session[] },
): SessionProcess[] {
  if (!registry.sessionsObserved()) throw new Error("no discovery sweep has completed yet");
  return sessionProcesses(registry.liveSessions());
}

/** The process and then each ancestor, by the table's parent links. */
function* lineage(process: Proc, byPid: ReadonlyMap<number, Proc>): Generator<Proc> {
  const seen = new Set<number>();
  for (let at: Proc | undefined = process; at && !seen.has(at.pid); at = byPid.get(at.ppid)) {
    seen.add(at.pid);
    yield at;
  }
}

/**
 * The label for each occupant of one process table, or null for a process nothing names.
 *
 * Ancestry alone decides that a process belongs to a session (S25). A shared cwd, pane or hook
 * coordinates prove nothing: an auxiliary CLI can inherit all three without being the session,
 * which is why upstream refuses such a process's hooks. A session outranks a background
 * process, because whatever a session spawned belongs to it, whichever role it plays.
 *
 * A label says what a process is and nothing more. Occupancy, every refusal and the orphan
 * report count a named process exactly as they count any other. The one thing a name changes is
 * Kill: a process with a `session` ends from that session, never from a card.
 */
export function knownOwnerLabels(
  sessions: () => readonly SessionProcess[],
): (table: readonly Proc[]) => (process: Proc) => KnownOwner | null {
  return (table) => {
    const byPid = new Map(table.map((process) => [process.pid, process]));
    const sessionAt = new Map(sessions().map((session) => [session.pid, session]));
    return (process) => {
      const chain = [...lineage(process, byPid)];
      const session = chain
        .map((at) => ({ at, session: sessionAt.get(at.pid) }))
        .find(({ at, session }) => session?.startMs === at.startMs)?.session;
      if (session) return { label: `Session ${session.name}`, session: { id: session.id, name: session.name } };
      for (const at of chain) {
        const agent = backgroundAgentOf(at.command);
        if (agent) return { label: `${AGENT_IDENTITY[agent].label} background process` };
      }
      const helper = IDE_HELPERS.get(executableName(process.command));
      return helper ? { label: helper } : null;
    };
  };
}
