import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { databaseBackupStatusFrom, type DatabaseBackupStatus } from "@shared/database-backups.ts";
import {
  backupFailedProblems,
  STORAGE_PROBLEM_KINDS,
  StorageFirstSeenSchema,
  type StorageBackupCopy,
  type StorageFirstSeen,
  type StorageHealth,
  type StorageProblem,
} from "@shared/storage-health.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

/**
 * How long a first-seen entry outlives its problem. A pass that misses a problem it should
 * have seen, such as one whose `ps` or `lsof` timed out, therefore keeps the same id.
 */
export const STORAGE_FIRST_SEEN_GRACE_MS = 60 * 60 * 1_000;

/**
 * What one source of storage problems saw on one pass.
 *
 *  - `problems` already carry ids built from durable state of their own.
 *  - `firstSeen` problems have no timestamp of their own, so the service stamps one: the
 *    first time their subject was seen, kept in the operational `storage.firstSeen` record.
 *  - `goneSubjects` no longer exist at all, so their first-seen entries are dropped at once
 *    instead of waiting out the grace.
 */
export interface StorageProblemObservation {
  problems?: StorageProblem[];
  firstSeen?: Array<{ subject: string; problem: (firstSeenAt: number) => StorageProblem }>;
  goneSubjects?: string[];
}

export type StorageProblemSource = () => StorageProblemObservation;

/**
 * Advance the first-seen record by one pass. A subject seen now keeps its first-seen time,
 * or gets `now` on first appearance; one not seen is kept until it has been absent for the
 * grace, and a gone one is dropped at once.
 */
export function advanceFirstSeen(
  record: StorageFirstSeen,
  present: Iterable<string>,
  gone: Iterable<string>,
  now: number,
): StorageFirstSeen {
  const next: StorageFirstSeen = {};
  const seen = new Set(present);
  const removed = new Set(gone);
  for (const [subject, entry] of Object.entries(record)) {
    if (removed.has(subject) || seen.has(subject)) continue;
    if (now - entry.lastSeenAt <= STORAGE_FIRST_SEEN_GRACE_MS) next[subject] = entry;
  }
  for (const subject of seen) {
    next[subject] = { firstSeenAt: record[subject]?.firstSeenAt ?? now, lastSeenAt: now };
  }
  return next;
}

interface StorageHealthDeps {
  backups: {
    status(): DatabaseBackupStatus;
    keptCopies(): StorageBackupCopy[];
  };
  /** Called with each recomputed aggregate that differs from the last one published. */
  publish(health: StorageHealth): void;
  /** Problem kinds beyond the backups' own, in the order they were registered. */
  sources?: StorageProblemSource[];
  now?: () => number;
  readFirstSeen?: () => StorageFirstSeen;
  writeFirstSeen?: (record: StorageFirstSeen) => void;
}

function storedFirstSeen(): StorageFirstSeen {
  const parsed = StorageFirstSeenSchema.safeParse(getAppConfig(APP_CONFIG_ENTRIES.storageFirstSeen));
  return parsed.success ? parsed.data : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KIND_ORDER = new Map(STORAGE_PROBLEM_KINDS.map((kind, index) => [kind, index]));

/**
 * The one storage aggregate behind Settings > Storage and the banner. It recomputes after
 * every capture and maintenance pass, and publishes only when the result changed, so a quiet
 * machine wakes no browser.
 */
export class StorageHealthService {
  private readonly sources: StorageProblemSource[];
  private readonly now: () => number;
  private readonly readFirstSeen: () => StorageFirstSeen;
  private readonly writeFirstSeen: (record: StorageFirstSeen) => void;
  private last: { health: StorageHealth; serialized: string } | null = null;

  constructor(private readonly deps: StorageHealthDeps) {
    this.sources = deps.sources ?? [];
    this.now = deps.now ?? Date.now;
    this.readFirstSeen = deps.readFirstSeen ?? storedFirstSeen;
    this.writeFirstSeen = deps.writeFirstSeen
      ?? ((record) => setAppConfig(APP_CONFIG_ENTRIES.storageFirstSeen, record));
  }

  /** The last published aggregate, computing one if none has been yet. */
  current(): StorageHealth {
    return this.last?.health ?? this.recompute();
  }

  recompute(): StorageHealth {
    const now = this.now();
    const status = this.attempt(
      "backup status", () => this.deps.backups.status(), databaseBackupStatusFrom(undefined),
    );
    const copies = this.attempt("kept copies", () => this.deps.backups.keptCopies(), []);
    const problems = backupFailedProblems(status);

    const firstSeen: NonNullable<StorageProblemObservation["firstSeen"]> = [];
    const gone: string[] = [];
    for (const source of this.sources) {
      const observation = this.attempt("problem source", source, {});
      problems.push(...(observation.problems ?? []));
      firstSeen.push(...(observation.firstSeen ?? []));
      gone.push(...(observation.goneSubjects ?? []));
    }
    problems.push(...this.stampFirstSeen(firstSeen, gone, now));
    problems.sort((left, right) =>
      KIND_ORDER.get(left.kind)! - KIND_ORDER.get(right.kind)! || left.id.localeCompare(right.id));

    const health: StorageHealth = {
      backups: {
        status,
        copies,
        totalBytes: copies.reduce((total, copy) => total + copy.bytes, 0),
      },
      problems,
    };
    const serialized = JSON.stringify(health);
    if (serialized !== this.last?.serialized) {
      this.last = { health, serialized };
      this.deps.publish(health);
    }
    return health;
  }

  private stampFirstSeen(
    observed: NonNullable<StorageProblemObservation["firstSeen"]>,
    gone: string[],
    now: number,
  ): StorageProblem[] {
    const before = this.attempt("first-seen record", this.readFirstSeen, {});
    const after = advanceFirstSeen(before, observed.map((each) => each.subject), gone, now);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      this.attempt("first-seen record", () => this.writeFirstSeen(after), undefined);
    }
    return observed.map((each) => each.problem(after[each.subject]!.firstSeenAt));
  }

  /** One input that fails is reported and left out; the rest of the aggregate still lands. */
  private attempt<T>(what: string, read: () => T, fallback: T): T {
    try {
      return read();
    } catch (error) {
      console.warn(`[mission-control] storage health could not read ${what}: ${errorMessage(error)}`);
      return fallback;
    }
  }
}
