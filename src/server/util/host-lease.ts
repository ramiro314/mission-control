import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A user-scoped, machine-wide lease: one holder per lease name per OS user, across every
// process on the host - several daemons, a Playwright suite, whatever else asks.
//
// The kernel is the arbiter. Holding the lease IS holding an exclusive loopback listen, so a
// holder that crashes frees it with no stale file to reclaim: the socket closes with the
// process. The owner metadata file beside it is only there to say WHO holds it while somebody
// waits, and to let a waiter tell a real holder from an unrelated program on the same port.
//
// Lifted out of `e2e/host-lease.ts`, which is now a thin caller. The Playwright lease and the
// workflow check test lease use this one mechanism with different names, so they never collide.

/**
 * Every lease name this repository takes, with the port range its user-derived port falls in.
 *
 * Ranges rather than a hash of the name so two leases can never land on the same port for some
 * unlucky uid. Append a name with a new, disjoint range; never move an existing one, because a
 * running holder built before the move would stop serialising against a waiter built after it.
 */
const LEASE_PORT_RANGES = {
  "mission-control-e2e": { base: 21_800, span: 1_000 },
  "mission-check-tests": { base: 22_800, span: 1_000 },
} as const;

export type HostLeaseName = keyof typeof LEASE_PORT_RANGES;

const DEFAULT_POLL_MS = 1_000;
const LEASE_HOST = "127.0.0.1";
const PROBE_TIMEOUT_MS = 1_000;
const OWNER_METADATA_GRACE_MS = 2_000;

export interface HostLeaseOwner {
  token: string;
  pid: number;
  acquiredAt: string;
  cwd: string;
  argv: string[];
  port: number;
}

export interface HostLease<Owner extends HostLeaseOwner = HostLeaseOwner> {
  owner: Owner;
  release(): Promise<void>;
}

export interface HostLeaseOptions<Details extends object = Record<never, never>> {
  name: HostLeaseName;
  /** How messages name this lease, for example "Mission Control E2E host lease". */
  label: string;
  /** How long to wait for another holder before failing. */
  waitMs: number;
  /** Extra fields published in the owner metadata beside the standard ones. */
  details?: Details;
  /** Called whenever the observed holder changes while waiting, with null if unidentified. */
  onWaiting?: (owner: (HostLeaseOwner & Partial<Details>) | null) => void;
  /** Overrides, for tests. Port 0 picks a free port, which a second acquirer then names. */
  port?: number;
  metadataPath?: string;
  pollMs?: number;
  metadataGraceMs?: number;
  // Used by the handoff regression test to hold metadata cleanup open.
  beforeReleaseMetadataRemoval?: () => Promise<void>;
}

function userIdentity(): string {
  const value = typeof process.getuid === "function"
    ? String(process.getuid())
    : process.env.USERNAME || process.env.USER || "user";
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function identityNumber(value: string): number {
  let result = 0;
  for (const character of value) result = ((result * 31) + character.charCodeAt(0)) >>> 0;
  return result;
}

export function hostLeasePort(name: HostLeaseName): number {
  const range = LEASE_PORT_RANGES[name];
  return range.base + (identityNumber(userIdentity()) % range.span);
}

export function hostLeaseMetadataPath(name: HostLeaseName): string {
  return join(tmpdir(), `${name}-${userIdentity()}.json`);
}

function protocolPrefix(name: HostLeaseName): string {
  return `${name}-lease-v1:`;
}

async function readOwner(metadataPath: string): Promise<HostLeaseOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<HostLeaseOwner>;
    if (
      typeof parsed.token !== "string"
      || !Number.isInteger(parsed.pid)
      || typeof parsed.acquiredAt !== "string"
      || typeof parsed.cwd !== "string"
      || !Array.isArray(parsed.argv)
      || !parsed.argv.every((part) => typeof part === "string")
      || !Number.isInteger(parsed.port)
    ) {
      return null;
    }
    return parsed as HostLeaseOwner;
  } catch {
    return null;
  }
}

async function publishOwner(metadataPath: string, owner: HostLeaseOwner): Promise<void> {
  await mkdir(dirname(metadataPath), { recursive: true });
  const candidate = `${metadataPath}.candidate-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(candidate, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" });
    await rename(candidate, metadataPath);
  } finally {
    await rm(candidate, { force: true });
  }
}

async function tryListen(port: number, greeting: string): Promise<Server | null> {
  const server = createServer((socket) => socket.end(greeting));
  return await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen({ host: LEASE_HOST, port, exclusive: true }, () => resolve(server));
  });
}

type LeaseProbe =
  | { kind: "free" }
  | { kind: "incompatible" }
  | { kind: "lease"; token: string };

async function probeLeaseHolder(port: number, protocol: string): Promise<LeaseProbe> {
  return await new Promise((resolve) => {
    const socket = connect({ host: LEASE_HOST, port });
    let response = "";
    let settled = false;
    const finish = (result: LeaseProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const parseResponse = (): LeaseProbe => {
      const line = response.trim();
      return line.startsWith(protocol) && line.length > protocol.length
        ? { kind: "lease", token: line.slice(protocol.length) }
        : { kind: "incompatible" };
    };
    const timeout = setTimeout(() => finish({ kind: "incompatible" }), PROBE_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 256) finish({ kind: "incompatible" });
      else if (response.includes("\n")) finish(parseResponse());
    });
    socket.once("end", () => finish(parseResponse()));
    socket.once("error", (error) => {
      finish((error as NodeJS.ErrnoException).code === "ECONNREFUSED"
        ? { kind: "free" }
        : { kind: "incompatible" });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// Deliberately a ref'd timer: a Playwright global setup waiting on this lease has nothing else
// keeping its event loop alive.
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for, then hold, the named machine-wide lease.
 *
 * Throws on a wait past `waitMs` (naming the live holder when it can), on a port held by
 * something that does not speak this lease's protocol, and on a protocol speaker that never
 * publishes matching owner metadata. Release is idempotent.
 */
export async function acquireHostLease<Details extends object = Record<never, never>>(
  options: HostLeaseOptions<Details>,
): Promise<HostLease<HostLeaseOwner & Details>> {
  const { label } = options;
  const protocol = protocolPrefix(options.name);
  const requestedPort = options.port ?? hostLeasePort(options.name);
  const metadataPath = options.metadataPath ?? hostLeaseMetadataPath(options.name);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const metadataGraceMs = options.metadataGraceMs ?? OWNER_METADATA_GRACE_MS;
  const deadline = Date.now() + options.waitMs;
  let reportedOwnerToken: string | null | undefined;
  let unverifiedSince: number | null = null;

  for (;;) {
    const token = randomUUID();
    const server = await tryListen(requestedPort, `${protocol}${token}\n`);
    if (server) {
      const address = server.address();
      if (!address || typeof address === "string") {
        await closeServer(server);
        throw new Error(`Could not read the ${label} port.`);
      }
      const owner = {
        ...options.details,
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        cwd: process.cwd(),
        argv: process.argv.slice(1),
        port: address.port,
      } as HostLeaseOwner & Details;
      try {
        await publishOwner(metadataPath, owner);
      } catch (error) {
        await closeServer(server);
        throw error;
      }

      let released = false;
      return {
        owner,
        release: async () => {
          if (released) return;
          released = true;
          try {
            const current = await readOwner(metadataPath);
            if (current?.token === owner.token) {
              await options.beforeReleaseMetadataRemoval?.();
              await rm(metadataPath, { force: true });
            }
          } finally {
            // Keep the kernel lease until this owner's metadata is gone. A successor
            // therefore cannot publish its token before the old cleanup completes.
            await closeServer(server);
          }
        },
      };
    }

    let probe = await probeLeaseHolder(requestedPort, protocol);
    if (probe.kind === "free") continue;
    if (probe.kind === "incompatible") {
      await sleep(100);
      probe = await probeLeaseHolder(requestedPort, protocol);
      if (probe.kind === "free") continue;
      if (probe.kind === "incompatible") {
        throw new Error(
          `Port ${requestedPort} is in use by a process that is not a compatible ${label}.`,
        );
      }
    }

    const observed = await readOwner(metadataPath);
    const current = observed?.token === probe.token ? observed : null;
    if (current) {
      unverifiedSince = null;
    } else if (unverifiedSince === null) {
      unverifiedSince = Date.now();
    } else if (Date.now() - unverifiedSince >= metadataGraceMs) {
      throw new Error(
        `Port ${requestedPort} speaks the ${label} protocol but did not `
        + `publish matching owner metadata within ${metadataGraceMs}ms.`,
      );
    }
    const currentToken = current?.token ?? null;
    if (reportedOwnerToken !== currentToken) {
      options.onWaiting?.(current as (HostLeaseOwner & Partial<Details>) | null);
      reportedOwnerToken = currentToken;
    }
    if (Date.now() >= deadline) {
      const holder = current
        ? ` It is held by pid ${current.pid} from ${current.cwd} since ${current.acquiredAt}.`
        : ` Port ${requestedPort} is in use, but no ${label} owner metadata is available.`;
      throw new Error(`Timed out waiting for the ${label} after ${options.waitMs}ms.${holder}`);
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
