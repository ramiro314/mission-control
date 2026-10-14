import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import type { WorktreeClaim } from "@shared/protocol.ts";
import { WORKFLOW_EXECUTION_LIMITS } from "@shared/workflow.ts";
import { readToken } from "../../shared/harness-runtime.mjs";
import { cleanupAgentSubprocessEnv } from "../agent-subprocess-env.ts";
import { executableLocator, loginShellVariables } from "../executables/locator.ts";
import { processLifetime } from "../platform/process-lifetime.ts";
import { run } from "../util/exec.ts";
import { scrubCheckEnv } from "../workflows/check-env.ts";
import { TailRing } from "../workflows/check-spawn.ts";
import type { GitResult } from "./git.ts";
import { trackOwnWorktreeProcess } from "./own-processes.ts";
import type { WorktreeOwner } from "./manager.ts";

// The dependency claim: a pool's ordered dependency steps, run inside a task lease after reset
// or add and setup, and before the final proof, so a leased slot has dependencies for the
// commit it was leased at.
//
// Three things live here, and the manager composes them:
//
//  - the step ENVIRONMENT: the scrubbed check base plus only the variables a step names;
//  - the FINGERPRINT that lets a slot whose dependencies already match skip the steps;
//  - the step RUNNER, with its bounded tail and its process-group timeout, and the registry
//    of claims running right now.
//
// Like a check, a claim step is not sandboxed. It runs operator-authored argv with the daemon's
// own filesystem authority. What the environment rule buys is narrower and stated exactly: a
// credential reaches only the step that names it, and never the setup command or a check by
// accident.

/** Grace between SIGTERM and SIGKILL when a step's process group is torn down. */
const KILL_GRACE_MS = 5_000;
/** How long to wait for the pipes to close after SIGKILL, so a stuck pipe cannot hang a claim. */
const DRAIN_MS = 5_000;
/** Bound on the failure text persisted on the slot row and shown to the agent. */
const MAX_FAILURE_BYTES = 6_000;
/** Bound on the failing command as rendered into a prompt or a failure record. */
const MAX_RENDERED_ARGV_BYTES = 512;

/** Every variable name any of the claim's steps lists, once each, sorted. */
export function claimVariableNames(claim: WorktreeClaim | null | undefined): string[] {
  if (!claim) return [];
  return [...new Set(claim.steps.flatMap((step) => step.env))].sort();
}

export interface ClaimEnvironment {
  env: NodeJS.ProcessEnv;
  /** Names that got a value. */
  received: string[];
  /** Names that got none: unset or empty everywhere, or carrying the daemon's own token. */
  missing: string[];
}

/**
 * The environment for one claim step, or for the setup command.
 *
 * `scrubCheckEnv` is the base, exactly as a check gets it: credential-shaped names, the
 * state-home overrides and the daemon token are gone, PATH is the locator's snapshot and the
 * child has its own disposable state home. On top of that base go ONLY the names asked for.
 * Each value comes from the daemon's environment, else from the login shell's.
 *
 * A value that carries the daemon's token is refused even when named, by the same rule
 * `scrubCheckEnv` applies by value. Pure, apart from the disposable home the base mints, which
 * the caller releases with `cleanupAgentSubprocessEnv`.
 */
export function buildClaimEnvironment(input: {
  names: readonly string[];
  daemonEnv: NodeJS.ProcessEnv;
  daemonToken: string;
  loginShell: Readonly<Record<string, string>>;
}): ClaimEnvironment {
  const env = scrubCheckEnv(input.daemonEnv, input.daemonToken);
  const token = input.daemonToken.trim();
  const received: string[] = [];
  const missing: string[] = [];
  for (const name of input.names) {
    const value = input.daemonEnv[name] || input.loginShell[name] || "";
    if (!value || (token.length > 0 && value.includes(token))) {
      missing.push(name);
      continue;
    }
    env[name] = value;
    received.push(name);
  }
  return { env, received, missing };
}

/**
 * The production environment source. The login shell is asked only for names the daemon's own
 * environment does not have, so a daemon started from a shell that exported them never forces
 * a probe.
 */
export async function claimEnvironment(names: readonly string[]): Promise<ClaimEnvironment> {
  const absent = names.filter((name) => !process.env[name]);
  const loginShell = absent.length > 0 ? await loginShellVariables(absent) : {};
  return buildClaimEnvironment({
    names,
    daemonEnv: process.env,
    daemonToken: readToken(),
    loginShell,
  });
}

export interface TreeBlob {
  path: string;
  /** The object id the tree records at that path. */
  object: string;
}

/**
 * Every blob (and gitlink) recorded at `sha`, read from objects with `ls-tree`, never from the
 * checkout. A step that rewrote a lockfile in the tree therefore cannot change the fingerprint
 * of the commit it was leased at.
 */
export async function readTreeBlobs(cwd: string, sha: string): Promise<GitResult<TreeBlob[]>> {
  const result = await trackOwnWorktreeProcess((onSpawn) =>
    run("git", ["-C", cwd, "ls-tree", "-r", "-z", "--full-tree", sha], {
      timeoutMs: 60_000,
      maxBuffer: 256 * 1024 * 1024,
      onSpawn,
    }),
  );
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) {
    return {
      ok: false,
      reason: `git ls-tree failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      outcomeUnknown: result.outcomeUnknown,
    };
  }
  return { ok: true, value: parseTreeBlobs(result.stdout) };
}

/** `<mode> SP <type> SP <object> TAB <path>`, NUL-terminated. Trees never appear with `-r`. */
export function parseTreeBlobs(stdout: string): TreeBlob[] {
  const blobs: TreeBlob[] = [];
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type, object] = record.slice(0, tab).split(" ");
    if ((type === "blob" || type === "commit") && object) {
      blobs.push({ path: record.slice(tab + 1), object });
    }
  }
  return blobs;
}

/**
 * The slot's dependency fingerprint, or null when the claim lists no fingerprint paths (which
 * means it always runs).
 *
 * A hash over the object ids of every path matching `fingerprintPaths`, every step's argv and
 * every step's variable names. Globs are `path.matchesGlob` globs over repository-relative
 * paths; as there, a wildcard does not match a segment that starts with a dot, so a dotfile
 * directory is named literally (`.yarn/releases/**`).
 */
export function claimFingerprint(claim: WorktreeClaim, blobs: readonly TreeBlob[]): string | null {
  if (claim.fingerprintPaths.length === 0) return null;
  const matched = blobs
    .filter((blob) => claim.fingerprintPaths.some((glob) => matchesGlob(blob.path, glob)))
    .map((blob) => [blob.path, blob.object] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        paths: matched,
        steps: claim.steps.map((step) => ({ argv: step.argv, env: step.env })),
      }),
    )
    .digest("hex");
}

export interface ClaimStepRequest {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
}

export type ClaimStepResult =
  | { outcome: "exited"; code: number | null; signal: string | null; tail: string; truncatedBytes: number }
  | { outcome: "timedOut" | "stopped"; tail: string; truncatedBytes: number }
  | { outcome: "spawnFailed"; reason: string };

/**
 * Run one step: argv through the executable locator, stdin closed, stdout and stderr into one
 * 4,000-byte tail (the same `TailRing` and bound as a check), in its own process group.
 *
 * Output size never fails a step: the ring drops the front and counts what it dropped. A
 * timeout or a Stop sends SIGTERM to the group, SIGKILL after a grace, and reports which.
 */
export async function runClaimStep(
  request: ClaimStepRequest,
  deps: {
    /** Defaults to the one locator. A cold or refreshing locator may probe the login shell. */
    resolveCommand?: (
      command: string,
      options: { env: NodeJS.ProcessEnv; cwd: string },
    ) => Promise<{ path: string; env: NodeJS.ProcessEnv } | null>;
    now?: () => number;
  } = {},
): Promise<ClaimStepResult> {
  const now = deps.now ?? Date.now;
  // The step's budget starts here, before the executable is resolved: resolution can wait on a
  // login-shell probe, and that wait belongs to the claim's deadline like everything else.
  const deadline = now() + Math.max(0, request.timeoutMs);
  const command = request.argv[0];
  if (!command) return { outcome: "spawnFailed", reason: "the step has no command" };
  const resolveCommand = deps.resolveCommand ??
    ((name, options) => executableLocator.resolveCommand(name, options));
  const resolved = await withinDeadline(
    resolveCommand(command, { env: request.env, cwd: request.cwd }),
    Math.max(0, request.timeoutMs),
    request.signal,
  );
  // Nothing has started, so there is no output and no process group to tear down. A resolution
  // that lands after this point is ignored: no process is ever launched for it.
  if (resolved.kind === "failed") return { outcome: "spawnFailed", reason: resolved.reason };
  if (resolved.kind !== "built") return { outcome: resolved.kind, tail: "", truncatedBytes: 0 };
  const executable = resolved.value;
  const remainingMs = deadline - now();
  if (remainingMs <= 0) return { outcome: "timedOut", tail: "", truncatedBytes: 0 };
  if (request.signal.aborted) return { outcome: "stopped", tail: "", truncatedBytes: 0 };
  if (!executable) {
    return {
      outcome: "spawnFailed",
      reason: `executable "${command}" was not found in the executable environment`,
    };
  }
  const ring = new TailRing(WORKFLOW_EXECUTION_LIMITS.checkOutput);
  return await new Promise<ClaimStepResult>((resolve) => {
    let settled = false;
    let ending: "timedOut" | "stopped" | null = null;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let child: ChildProcess;
    const finish = (result: ClaimStepResult): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const tail = () => ring.read();
    const terminate = (why: "timedOut" | "stopped"): void => {
      if (ending || settled) return;
      ending = why;
      try {
        if (child.pid) processLifetime.signalTree(child.pid, "SIGTERM");
      } catch {
        // Already gone; the close below settles it.
      }
      timers.push(setTimeout(() => {
        processLifetime.killTree(child);
        timers.push(setTimeout(() => {
          const { text, truncatedBytes } = tail();
          finish({ outcome: why, tail: text, truncatedBytes });
        }, DRAIN_MS));
      }, KILL_GRACE_MS));
    };
    const onAbort = (): void => terminate("stopped");
    try {
      child = spawn(executable.path, request.argv.slice(1), {
        ...processLifetime.treeRootOptions,
        cwd: request.cwd,
        env: executable.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ outcome: "spawnFailed", reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => ring.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => ring.push(chunk));
    child.once("error", (error) => {
      if (child.pid === undefined) finish({ outcome: "spawnFailed", reason: error.message });
    });
    child.once("close", (code, signal) => {
      const { text, truncatedBytes } = tail();
      finish(ending
        ? { outcome: ending, tail: text, truncatedBytes }
        : { outcome: "exited", code, signal, tail: text, truncatedBytes });
    });
    timers.push(setTimeout(() => terminate("timedOut"), remainingMs));
    if (request.signal.aborted) terminate("stopped");
    else request.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** What a failed claim tells the slot row, the task and the agent. */
export interface WorktreeClaimWarning {
  /** 1-based, of `stepCount`. */
  step: number;
  stepCount: number;
  argv: string[];
  reason: string;
  tail: string;
  truncatedBytes: number;
}

export type ClaimStepsOutcome =
  | { ok: true }
  | { ok: false; stopped: boolean; warning: WorktreeClaimWarning };

/**
 * Wait for `pending` for at most `ms`, or until the claim is stopped. `onLate` receives a value
 * that arrives after the wait gave up, so whatever it holds is released rather than leaked.
 */
async function withinDeadline<T>(
  pending: Promise<T>,
  ms: number,
  signal: AbortSignal,
  onLate: (value: T) => void = () => {},
): Promise<
  | { kind: "built"; value: T }
  | { kind: "failed"; reason: string }
  | { kind: "timedOut" | "stopped" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let abandoned = false;
  const settled = pending.then(
    (value) => {
      if (abandoned) onLate(value);
      return { kind: "built" as const, value };
    },
    (error: unknown) => ({
      kind: "failed" as const,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  // `abandoned` is set in the same callback that gives up, so whichever of the two settles
  // first decides both the race and who releases the late value.
  const gaveUp = new Promise<{ kind: "timedOut" | "stopped" }>((resolve) => {
    timer = setTimeout(() => {
      abandoned = true;
      resolve({ kind: "timedOut" });
    }, ms);
    onAbort = () => {
      abandoned = true;
      resolve({ kind: "stopped" });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([settled, gaveUp]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Run every step in order under one deadline. Any failing step fails the claim and the rest
 * do not run. Each step's environment is built for it alone and released afterwards.
 */
export async function runClaimSteps(input: {
  claim: WorktreeClaim;
  cwd: string;
  signal: AbortSignal;
  environment: (names: readonly string[]) => Promise<ClaimEnvironment>;
  runStep: (request: ClaimStepRequest) => Promise<ClaimStepResult>;
  now: () => number;
}): Promise<ClaimStepsOutcome> {
  const limitMs = input.claim.timeoutMinutes * 60_000;
  const deadline = input.now() + limitMs;
  const stepCount = input.claim.steps.length;
  const timedOut = `timed out at the claim's ${input.claim.timeoutMinutes}-minute limit`;
  for (const [index, step] of input.claim.steps.entries()) {
    const fail = (
      reason: string,
      tail = "",
      truncatedBytes = 0,
      stopped = false,
    ): ClaimStepsOutcome => ({
      ok: false,
      stopped,
      warning: { step: index + 1, stepCount, argv: [...step.argv], reason, tail, truncatedBytes },
    });
    if (input.signal.aborted) return fail("stopped before it started", "", 0, true);
    const beforeEnvironment = deadline - input.now();
    if (beforeEnvironment <= 0) return fail(timedOut);
    // Building the environment can probe the login shell, so it spends the same deadline.
    const prepared = await withinDeadline(
      input.environment(step.env),
      beforeEnvironment,
      input.signal,
      (late) => cleanupAgentSubprocessEnv(late.env),
    );
    if (prepared.kind === "failed") return fail(`its environment could not be built: ${prepared.reason}`);
    if (prepared.kind !== "built") {
      return prepared.kind === "stopped" ? fail("was stopped", "", 0, true) : fail(timedOut);
    }
    const built = prepared.value;
    // Recomputed after the environment, so the step gets only what is truly left.
    const remaining = deadline - input.now();
    if (remaining <= 0) {
      cleanupAgentSubprocessEnv(built.env);
      return fail(timedOut);
    }
    let result: ClaimStepResult;
    try {
      result = await input.runStep({
        argv: step.argv,
        cwd: input.cwd,
        env: built.env,
        timeoutMs: remaining,
        signal: input.signal,
      });
    } catch (error) {
      result = { outcome: "spawnFailed", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      cleanupAgentSubprocessEnv(built.env);
    }
    const missing = built.missing.length > 0 ? ` (no value for ${built.missing.join(", ")})` : "";
    switch (result.outcome) {
      case "exited":
        if (result.code === 0) continue;
        return fail(
          (result.signal ? `was killed by ${result.signal}` : `exited with code ${result.code}`) + missing,
          result.tail,
          result.truncatedBytes,
        );
      case "timedOut":
        return fail(timedOut, result.tail, result.truncatedBytes);
      case "stopped":
        return fail("was stopped", result.tail, result.truncatedBytes, true);
      case "spawnFailed":
        return fail(`could not start: ${result.reason}`);
    }
  }
  return { ok: true };
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^�+/, "");
}

/**
 * The failing step's command as text, cut to a fixed byte bound. A valid step may hold 32
 * arguments of 4,096 bytes each, and the agent needs to recognize the command, not read all of
 * it; the cut is deterministic and says how much it dropped.
 */
export function renderClaimArgv(argv: readonly string[]): string {
  const full = argv.join(" ");
  const bytes = Buffer.from(full, "utf8");
  if (bytes.length <= MAX_RENDERED_ARGV_BYTES) return full;
  const kept = bytes.subarray(0, MAX_RENDERED_ARGV_BYTES).toString("utf8").replace(/�+$/, "");
  return `${kept}... (${bytes.length - Buffer.byteLength(kept, "utf8")} more bytes)`;
}

/** The failing step's one-line summary, persisted on the slot with its tail. */
export function describeClaimFailure(warning: WorktreeClaimWarning): string {
  const head = `step ${warning.step} of ${warning.stepCount} (${renderClaimArgv(warning.argv)}) ${warning.reason}`;
  return boundedText(warning.tail ? `${head}\n${warning.tail}` : head, MAX_FAILURE_BYTES);
}

/** A backtick run longer than any in `text`, at least `minimum` long, so `text` cannot close it. */
function fenceFor(text: string, minimum = 3): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(minimum, longest + 1));
}

/** Inline Markdown code that a backtick inside the command cannot end early. */
function inlineCode(text: string): string {
  const fence = fenceFor(text, 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * The note an agent's launch prompt carries when a claim failed in one of its worktrees: the
 * failing step and its output tail, and what that means for the work. Empty when nothing failed.
 */
export function claimWarningsBlock(
  warnings: ReadonlyArray<{ path: string; warning: WorktreeClaimWarning }>,
): string {
  if (warnings.length === 0) return "";
  const lines = ["## Dependency install warning", ""];
  for (const { path, warning } of warnings) {
    lines.push(
      `Mission Control's dependency claim for ${path} failed, so the installed dependencies in`,
      "that worktree may not match its commit.",
      "",
      `Failing step ${warning.step} of ${warning.stepCount}: ${inlineCode(renderClaimArgv(warning.argv))} ${warning.reason}.`,
    );
    if (warning.tail) {
      const fence = fenceFor(warning.tail);
      const dropped = warning.truncatedBytes > 0
        ? ` (the last part; ${warning.truncatedBytes} earlier bytes were dropped)`
        : "";
      lines.push("", `Its output${dropped}:`, "", fence, warning.tail.replace(/\n+$/, ""), fence);
    }
    lines.push("");
  }
  lines.push(
    "Install or repair the dependencies yourself before you build or test, and say in your",
    "result if a failure you hit came from them rather than from your change.",
    "",
    "---",
    "",
  );
  return lines.join("\n");
}

export interface RunningClaim {
  slotId: string;
  owner: WorktreeOwner;
  startedAt: number;
}

/**
 * The claims running right now, keyed by slot. In memory by design: a claim cannot outlive the
 * daemon that runs it, and what a crash leaves behind is the durable `deps_state` write-ahead,
 * which startup reconciliation reads instead.
 *
 * Maintenance asks it which slots to skip rather than wait on, and shutdown stops every claim
 * through it.
 */
export class ClaimRegistry {
  private readonly running = new Map<string, RunningClaim & { controller: AbortController }>();
  private stoppingValue = false;

  /** Null once shutdown has begun: no new claim starts while the daemon stops. */
  register(slotId: string, owner: WorktreeOwner, now: number): AbortController | null {
    if (this.stoppingValue) return null;
    const controller = new AbortController();
    this.running.set(slotId, { slotId, owner, startedAt: now, controller });
    return controller;
  }

  unregister(slotId: string, controller: AbortController): void {
    if (this.running.get(slotId)?.controller === controller) this.running.delete(slotId);
  }

  has(slotId: string): boolean {
    return this.running.has(slotId);
  }

  get stopping(): boolean {
    return this.stoppingValue;
  }

  list(): RunningClaim[] {
    return [...this.running.values()].map(({ slotId, owner, startedAt }) => ({ slotId, owner, startedAt }));
  }

  /** Shutdown: refuse new claims and stop every running one. */
  stopAll(): void {
    this.stoppingValue = true;
    for (const claim of this.running.values()) claim.controller.abort("shutdown");
  }

  /** Re-arm after `stopAll`, for a manager restarted in the same process (tests). */
  resume(): void {
    this.stoppingValue = false;
  }
}
