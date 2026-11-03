import { setImmediate as yieldToLoop, setTimeout as sleep } from "node:timers/promises";
import type { HistoryProgress } from "@shared/history.ts";
import { AGENT_TYPES, type AgentType } from "@shared/types.ts";
import { HARNESSES } from "../harness/index.ts";
import type { HistoryFile, HistoryParse, HistorySpec } from "../harness/types.ts";
import { unref } from "../util/timers.ts";
import { resolveHistoryRepository } from "./repository.ts";
import type { HistoryIndexEntry, HistoryStore, HistoryUpsert } from "./store.ts";

/**
 * Keeps the Session History catalog in step with the agents' transcript stores, on the Scout
 * archive reconciler's model (`archives/reconciler.ts`):
 *
 * - **Unchanged transcripts cost one `lstat`.** A file whose size, mtime and inode match its
 *   row is not opened. A changed one is re-summarized from where its last parse stopped.
 * - **Backfill is newest first, in small batches.** Each batch is summarized, written in ONE
 *   short transaction, and followed by a yield to the event loop, so a first run over
 *   thousands of transcripts never holds the daemon or SQLite for long. Progress is exposed
 *   so the page can say "Indexing N of M sessions" while rows appear.
 * - **Gone follows a COMPLETE walk.** A row is marked gone only when a pass walked every root
 *   of its harness and did not see the file - never because a root could not be read or a
 *   pass was stopped. Rows are never deleted.
 *
 * Started after the daemon is serving, and never awaited by startup.
 */

export interface HistoryReader {
  agent: AgentType;
  spec: HistorySpec;
}

export interface HistoryReconcilerOptions {
  store: HistoryStore;
  /** Defaults to every harness with a non-null `history` slot. */
  readers?: readonly HistoryReader[];
  /** Recurring cadence in ms, or null to run only when triggered. */
  intervalMs?: number | null;
  batchSize?: number;
  /** An extra pause after each batch; 0 in production. */
  batchPauseMs?: number;
  /** Repository resolution, injectable for tests. Defaults to the store's pools and tasks. */
  resolveRepository?: (cwd: string | null) => string | null;
  now?: () => number;
}

/** What one pass did, for tests and a log line. */
export interface HistoryReconcilePass {
  scanned: number;
  indexed: number;
  gone: number;
  failed: number;
  complete: boolean;
}

/** Every harness that has a history reader, in `AGENT_TYPES` order. */
export function historyReaders(): HistoryReader[] {
  return AGENT_TYPES.flatMap((agent) => {
    const spec = HARNESSES[agent].history;
    return spec ? [{ agent, spec }] : [];
  });
}

function sameFile(entry: HistoryIndexEntry | undefined, file: HistoryFile): boolean {
  const known = entry?.fingerprint;
  return !!entry
    && !!known
    && entry.transcriptState === "present"
    && entry.transcriptPath === file.path
    && known.size === file.fingerprint.size
    && known.mtimeMs === file.fingerprint.mtimeMs
    && known.ino === file.fingerprint.ino;
}

/** A fingerprint as one comparable string. */
function fingerprintKey(file: HistoryFile): string {
  return `${file.fingerprint.ino}:${file.fingerprint.size}:${file.fingerprint.mtimeMs}`;
}

/** Every file of a duplicate-id group and its fingerprint, independent of scan order. */
function groupSignature(group: readonly HistoryFile[]): string {
  return group.map((file) => `${file.path}|${fingerprintKey(file)}`).sort().join("\n");
}

export class HistoryReconciler {
  private readonly store: HistoryStore;
  private readonly readers: readonly HistoryReader[];
  private readonly intervalMs: number | null;
  private readonly batchSize: number;
  private readonly batchPauseMs: number;
  private readonly resolveRepositoryOverride: ((cwd: string | null) => string | null) | null;
  private readonly now: () => number;
  private readonly complainedRoots = new Set<string>();
  /**
   * Files a reader summarized to nothing (an empty transcript, or one with no record a row can
   * be built from), by path, with the fingerprint they had. They have no row for `sameFile` to
   * match, so without this each pass would read them again from byte 0. Kept in memory: a
   * restart re-reads each once.
   *
   * Per agent, like `groupChoices`: each reader's walk prunes only its own entries, so a second
   * harness with a reader never clears the first one's.
   */
  private readonly emptyByAgent = new Map<AgentType, Map<string, string>>();
  /**
   * For a session id several files share, the group's signature when its canonical file was
   * last chosen. Choosing summarizes every candidate from the top, so it runs again only when a
   * file in the group appeared, went, or changed. Per agent, because a session id is unique only
   * within one harness.
   */
  private readonly groupChoicesByAgent = new Map<AgentType, Map<string, string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<HistoryReconcilePass> | null = null;
  private retrigger = false;
  private stopped = false;
  private passes = 0;
  /**
   * `start()` marks it indexing until the first walk says otherwise, so a page opened during
   * startup reads "indexing" rather than an empty history nobody has looked at yet.
   */
  private state: HistoryProgress = { indexing: false, indexed: 0, total: 0 };

  /** One agent's entry in a per-agent cache, created on first use. */
  private static forAgent<T>(caches: Map<AgentType, Map<string, T>>, agent: AgentType): Map<string, T> {
    let cache = caches.get(agent);
    if (!cache) {
      cache = new Map();
      caches.set(agent, cache);
    }
    return cache;
  }

  constructor(options: HistoryReconcilerOptions) {
    this.store = options.store;
    this.readers = options.readers ?? historyReaders();
    this.intervalMs = options.intervalMs ?? null;
    this.batchSize = Math.max(1, options.batchSize ?? 25);
    this.batchPauseMs = Math.max(0, options.batchPauseMs ?? 0);
    this.resolveRepositoryOverride = options.resolveRepository ?? null;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.stopped) return;
    if (this.passes === 0 && !this.running) this.state = { indexing: true, indexed: 0, total: 0 };
    void this.trigger().finally(() => this.schedule());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  progress(): HistoryProgress {
    return { ...this.state };
  }

  get passCount(): number {
    return this.passes;
  }

  /** Ask for a pass. Passes are serialized; triggers during one coalesce into one more. */
  trigger(): Promise<HistoryReconcilePass> {
    if (this.running) {
      this.retrigger = true;
      return this.running;
    }
    const pass = this.runPass()
      .catch((error: unknown): HistoryReconcilePass => {
        console.warn("[history] reconcile pass failed:", error);
        this.state = { ...this.state, indexing: false };
        return { scanned: 0, indexed: 0, gone: 0, failed: 0, complete: false };
      })
      .then((result) => {
        this.running = null;
        if (this.retrigger && !this.stopped) {
          this.retrigger = false;
          return this.trigger();
        }
        this.retrigger = false;
        return result;
      });
    this.running = pass;
    return pass;
  }

  private schedule(): void {
    if (this.stopped || this.intervalMs === null) return;
    this.timer = unref(setTimeout(() => {
      void this.trigger().finally(() => this.schedule());
    }, this.intervalMs));
  }

  private repositoryResolver(): (cwd: string | null) => string | null {
    if (this.resolveRepositoryOverride) return this.resolveRepositoryOverride;
    const pools = this.store.worktreePools();
    const cache = new Map<string, string | null>();
    return (cwd) => {
      if (!cwd) return null;
      if (!cache.has(cwd)) {
        cache.set(cwd, resolveHistoryRepository(cwd, { pools, taskRepoRoot: (id) => this.store.taskRepoRoot(id) }));
      }
      return cache.get(cwd)!;
    };
  }

  private async runPass(): Promise<HistoryReconcilePass> {
    this.passes += 1;
    const result: HistoryReconcilePass = { scanned: 0, indexed: 0, gone: 0, failed: 0, complete: true };
    const resolveRepository = this.repositoryResolver();

    // Walk every reader first, so progress names the whole job before the first batch.
    const plans: { reader: HistoryReader; complete: boolean; seen: Set<string>; work: HistoryFile[];
      parsed: Map<string, HistoryParse>; index: Map<string, HistoryIndexEntry>; empty: Map<string, string> }[] = [];
    for (const reader of this.readers) {
      const empty = HistoryReconciler.forAgent(this.emptyByAgent, reader.agent);
      const groupChoices = HistoryReconciler.forAgent(this.groupChoicesByAgent, reader.agent);
      const files: HistoryFile[] = [];
      let complete = true;
      for (const root of reader.spec.roots()) {
        try {
          files.push(...await reader.spec.enumerate(root));
          this.complainedRoots.delete(root);
        } catch (error) {
          complete = false;
          if (!this.complainedRoots.has(root)) {
            this.complainedRoots.add(root);
            console.warn(`[history] could not walk ${root}; its rows are kept as they are:`, error);
          }
        }
      }
      if (this.stopped) return { ...result, complete: false };
      result.scanned += files.length;
      const index = this.store.index(reader.agent);
      const byId = new Map<string, HistoryFile[]>();
      for (const file of files) {
        const group = byId.get(file.agentSessionId);
        if (group) group.push(file);
        else byId.set(file.agentSessionId, [file]);
      }
      const parsed = new Map<string, HistoryParse>();
      const canonical: HistoryFile[] = [];
      const walkedPaths = new Set(files.map((file) => file.path));
      for (const path of empty.keys()) if (!walkedPaths.has(path)) empty.delete(path);
      for (const [id, group] of byId) {
        if (group.length === 1) {
          canonical.push(group[0]!);
          continue;
        }
        // Rare: several files share one session id. Nothing in the group changed since the
        // last choice, and the row still follows one of its files unchanged: keep that one.
        const signature = groupSignature(group);
        const kept = group.find((file) => sameFile(index.get(id), file));
        if (kept && groupChoices.get(id) === signature) {
          canonical.push(kept);
          continue;
        }
        // Otherwise each candidate is summarized from the top so the harness's stable rule can
        // choose, and the chosen parse is kept for the write.
        const candidates: { file: HistoryFile; parse: HistoryParse }[] = [];
        let unreadable = false;
        for (const file of group) {
          if (empty.get(file.path) === fingerprintKey(file)) continue;
          const parse = await reader.spec.summarize(file, null).catch(() => undefined);
          if (parse === undefined) unreadable = true;
          else if (parse === null) empty.set(file.path, fingerprintKey(file));
          else candidates.push({ file, parse });
        }
        // A candidate that could not be read leaves the choice open for the next pass.
        if (unreadable) groupChoices.delete(id);
        else groupChoices.set(id, signature);
        if (candidates.length === 0) continue;
        const chosen = reader.spec.canonical(candidates.map(({ file, parse }) => ({ path: file.path, summary: parse.summary })));
        const winner = candidates.find(({ file }) => file.path === chosen) ?? candidates[0]!;
        canonical.push(winner.file);
        if (!sameFile(index.get(winner.file.agentSessionId), winner.file)) parsed.set(winner.file.path, winner.parse);
      }
      for (const id of groupChoices.keys()) if ((byId.get(id)?.length ?? 0) < 2) groupChoices.delete(id);
      const work = canonical
        .filter((file) => !sameFile(index.get(file.agentSessionId), file))
        .filter((file) => empty.get(file.path) !== fingerprintKey(file))
        .sort((a, b) => b.fingerprint.mtimeMs - a.fingerprint.mtimeMs || (a.path < b.path ? -1 : 1));
      plans.push({ reader, complete, seen: new Set(byId.keys()), work, parsed, index, empty });
      this.state = {
        indexing: plans.some((entry) => entry.work.length > 0),
        indexed: plans.reduce((sum, plan) => sum + plan.seen.size - plan.work.length, 0),
        total: plans.reduce((sum, plan) => sum + plan.seen.size, 0),
      };
    }

    for (const plan of plans) {
      const { agent, spec } = plan.reader;
      for (let start = 0; start < plan.work.length; start += this.batchSize) {
        if (this.stopped) return { ...result, complete: false };
        const batch = plan.work.slice(start, start + this.batchSize);
        const rows: HistoryUpsert[] = [];
        for (const file of batch) {
          const entry = plan.index.get(file.agentSessionId);
          let parse = plan.parsed.get(file.path) ?? null;
          if (!parse) {
            const previous = entry && entry.transcriptState === "present" && entry.transcriptPath === file.path
              ? this.store.parsePoint(agent, file.agentSessionId)
              : null;
            try {
              parse = await spec.summarize(file, previous);
            } catch {
              // Vanished or unreadable mid-pass: not written, so the next pass tries again.
              result.failed += 1;
              continue;
            }
          }
          if (!parse) {
            // Nothing to build a row from. Remembered, so it is not read again until it changes.
            plan.empty.set(file.path, fingerprintKey(file));
            continue;
          }
          plan.empty.delete(file.path);
          rows.push({
            agent,
            agentSessionId: file.agentSessionId,
            transcriptPath: file.path,
            fingerprint: file.fingerprint,
            parsedBytes: parse.parsedBytes,
            readerState: parse.state,
            repoRoot: resolveRepository(parse.summary.cwd),
            summary: parse.summary,
            fallbackActivityAt: file.fingerprint.mtimeMs,
          });
        }
        this.store.upsertBatch(rows, this.now());
        result.indexed += rows.length;
        this.state = { ...this.state, indexed: Math.min(this.state.total, this.state.indexed + batch.length) };
        await yieldToLoop();
        if (this.batchPauseMs > 0) await sleep(this.batchPauseMs, undefined, { ref: false });
      }
      if (this.stopped) return { ...result, complete: false };
      if (plan.complete) result.gone += this.store.markGone(agent, plan.seen, this.now());
      else result.complete = false;
    }
    this.state = { indexing: false, indexed: this.state.total, total: this.state.total };
    return result;
  }
}
