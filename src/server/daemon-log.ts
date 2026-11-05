// The daemon's own durable log, for launches whose output nobody else keeps.
//
// Electron's `startDaemon` and the installed service capture the daemon's stdout and stderr
// themselves (into `daemon.log`, or the journal) and say so with
// `MISSION_DAEMON_LOG_CAPTURED=1`. A dev launch (`make start`, `make up`) has only a terminal
// or `.harness.log`, so quarantine and recovery lines died with it. This appends the same
// output to `$MISSION_HOME/daemon.log` and rotates it, and writes nothing when the launcher
// already captures it, so the packaged app's log is unchanged and no line lands twice.
//
// Every append opens the file by path, as Electron main's `logMain` does, so a rotation by
// either writer never strands the other on a renamed file.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { envVar, stateDir } from "@shared/harness-runtime.mjs";

export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DAEMON_LOG_KEEP = 3;

type WritableOutput = Pick<NodeJS.WriteStream, "write">;

export interface DaemonLogOptions {
  path: string;
  streams?: readonly WritableOutput[];
  maxBytes?: number;
  keep?: number;
  /** False appends without ever rotating, until `allowRotation()`. */
  rotate?: boolean;
}

export interface DaemonLogCapture {
  /** Append everything written so far. Runs on its own after each batch and at exit. */
  flush(): void;
  /** Start rotating, from the next batch on. */
  allowRotation(): void;
  /** Put the streams' own `write` back, after a final flush. */
  stop(): void;
}

/** Shift `path` to `path.1`, `path.1` to `path.2`, and so on, dropping `path.<keep>`. */
export function rotateDaemonLog(path: string, keep = DAEMON_LOG_KEEP): void {
  rmSync(`${path}.${keep}`, { force: true });
  for (let n = keep - 1; n >= 1; n -= 1) moveIfPresent(`${path}.${n}`, `${path}.${n + 1}`);
  moveIfPresent(path, `${path}.1`);
}

function moveIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

/**
 * Copy every write on `streams` into `path`. Writes still reach the streams unchanged; the
 * copies are batched, and the file's size is checked before each batch is appended.
 */
export function teeToDaemonLog(options: DaemonLogOptions): DaemonLogCapture {
  const { path, maxBytes = DAEMON_LOG_MAX_BYTES, keep = DAEMON_LOG_KEEP } = options;
  const streams = options.streams ?? [process.stdout, process.stderr];
  const originals = streams.map((stream) => stream.write);
  const reportError = originals[originals.length - 1]!.bind(streams[streams.length - 1]);
  let pending: Buffer[] = [];
  let scheduled = false;
  let reported = false;
  let rotate = options.rotate ?? true;

  const flush = (): void => {
    scheduled = false;
    if (pending.length === 0) return;
    const batch = Buffer.concat(pending);
    pending = [];
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (rotate && (statSync(path, { throwIfNoEntry: false })?.size ?? 0) >= maxBytes) rotateDaemonLog(path, keep);
      appendFileSync(path, batch, { mode: 0o600 });
    } catch (error) {
      // Through the original write, so the warning is not itself queued for the same file.
      if (reported) return;
      reported = true;
      reportError(`[daemon-log] could not append to ${path}: ${(error as Error).message}\n`);
    }
  };

  streams.forEach((stream, index) => {
    const original = originals[index]!;
    stream.write = function (this: WritableOutput, chunk: unknown, encoding?: unknown, callback?: unknown) {
      pending.push(toBuffer(chunk, encoding));
      if (!scheduled) {
        scheduled = true;
        setImmediate(flush).unref();
      }
      return (original as (...args: unknown[]) => boolean).call(this, chunk, encoding, callback);
    } as WritableOutput["write"];
  });

  // Node prints an uncaught exception straight to the stderr descriptor, bypassing `write`,
  // and a crash is the line this log most needs to keep.
  const onCrash = (error: unknown): void => {
    pending.push(Buffer.from(`${error instanceof Error && error.stack ? error.stack : String(error)}\n`));
    flush();
  };
  process.on("uncaughtExceptionMonitor", onCrash);
  process.on("exit", flush);

  return {
    flush,
    allowRotation() { rotate = true; },
    stop() {
      flush();
      streams.forEach((stream, index) => { stream.write = originals[index]!; });
      process.off("uncaughtExceptionMonitor", onCrash);
      process.off("exit", flush);
    },
  };
}

/** True when the daemon's launcher already keeps its output, so this module must not. */
export function daemonLogCaptured(): boolean {
  return envVar("DAEMON_LOG_CAPTURED") === "1";
}

/**
 * Start the daemon's own log unless its launcher captures the output. It appends without
 * rotating until the daemon owns its state (`allowRotation()`): a dev launch refused because a
 * service already owns this home must not rename the `daemon.log` that service's launcher
 * holds open, while its refusal line, appended alongside, is still kept.
 */
export function startDaemonLog(): DaemonLogCapture | null {
  const captured = daemonLogCaptured();
  // The variable describes this process's launcher only. A dev daemon started from a shell this
  // daemon launched (a terminal session, an agent) has no such launcher and must keep its log.
  for (const prefix of ["MISSION", "FLEET", "HARNESS"]) delete process.env[`${prefix}_DAEMON_LOG_CAPTURED`];
  if (captured) return null;
  return teeToDaemonLog({ path: join(stateDir(), "daemon.log"), rotate: false });
}
