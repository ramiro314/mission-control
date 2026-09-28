import {
  acquireHostLease,
  hostLeaseMetadataPath,
  hostLeasePort,
  type HostLease,
  type HostLeaseOwner,
} from "../src/server/util/host-lease.ts";

// The Playwright suite's machine-wide lease: one E2E run per user per host. The mechanism
// lives in `src/server/util/host-lease.ts`; this keeps the E2E name, port, metadata path,
// worker ceiling and 45-minute wait it always had.

export const E2E_MAX_WORKERS = 4;

const LEASE_NAME = "mission-control-e2e";
const LEASE_LABEL = "Mission Control E2E host lease";
const DEFAULT_WAIT_TIMEOUT_MS = 45 * 60_000;

export interface E2eLeaseOwner extends HostLeaseOwner {
  workers: number;
}

export type E2eHostLease = HostLease<E2eLeaseOwner>;

interface AcquireOptions {
  workers: number;
  port?: number;
  metadataPath?: string;
  pollMs?: number;
  waitTimeoutMs?: number;
  metadataGraceMs?: number;
  onWait?: (owner: E2eLeaseOwner | null) => void;
  // Used by the handoff regression test to hold metadata cleanup open.
  beforeReleaseMetadataRemoval?: () => Promise<void>;
}

export function defaultE2eLeasePort(): number {
  return hostLeasePort(LEASE_NAME);
}

export function defaultE2eLeaseMetadataPath(): string {
  return hostLeaseMetadataPath(LEASE_NAME);
}

export function assertE2eWorkerLimit(workers: number): void {
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`Playwright resolved an invalid worker count: ${workers}`);
  }
  if (workers > E2E_MAX_WORKERS) {
    throw new Error(
      `Mission Control E2E tests are limited to ${E2E_MAX_WORKERS} workers per host; `
      + `this run resolved ${workers}. Remove the --workers override or choose a value from 1 to ${E2E_MAX_WORKERS}.`,
    );
  }
}

export async function acquireE2eHostLease(options: AcquireOptions): Promise<E2eHostLease> {
  assertE2eWorkerLimit(options.workers);
  return await acquireHostLease({
    name: LEASE_NAME,
    label: LEASE_LABEL,
    waitMs: options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    details: { workers: options.workers },
    // Validated, so the cast below is sound: a file without an integer `workers` is no owner.
    isDetails: (value) => Number.isInteger(value.workers),
    onWaiting: options.onWait
      ? (owner) => options.onWait!(owner as E2eLeaseOwner | null)
      : undefined,
    port: options.port,
    metadataPath: options.metadataPath,
    pollMs: options.pollMs,
    metadataGraceMs: options.metadataGraceMs,
    beforeReleaseMetadataRemoval: options.beforeReleaseMetadataRemoval,
  });
}
