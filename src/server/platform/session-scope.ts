import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { locateExecutableSync } from "../executables/locator.ts";
import { socketExists, userManagerReachable } from "../graphical-session.ts";
import { stateDir } from "../../shared/harness-runtime.mjs";
import { resolveCurrentOwnedRuntime } from "../../shared/owned-runtime.mjs";
import { run } from "../util/exec.ts";
import { underTestRunner } from "../util/test-runner.ts";

// Session scope: on Linux, a long-lived agent session process and everything it starts run in a
// transient systemd scope of their own, so an OOM kill inside a session stops that session only.
//
// Without it the agent shares the daemon's unit. When the kernel OOM-kills one process there,
// systemd's `OOMPolicy=stop` then stops the whole unit: the daemon, the dashboard renderer and
// every other session go with it. With it, the unit systemd stops is the session's.
//
// `systemd-run --scope` and `choom` both exec in place, so the child's pid, stdio, signals and
// exit status are the agent's exactly as an unwrapped spawn's would be.
//
// Each harness wraps at the spawn seam it already owns (the Claude `spawnClaudeCodeProcess`
// hook, and Pi's bash-tool `spawnHook` for each command) through the one `SessionScope` below;
// nothing above a seam branches on it.

/** The slice every session scope goes in, nested under `app.slice` by its name. */
export const SESSIONS_SLICE = "app-mission\\x2dcontrol\\x2dsessions.slice";

/** The `oom_score_adj` agents run at: above Chromium's renderer (300) and the daemon's. */
export const SESSION_OOM_SCORE_ADJ = 500;

/** How long the startup probe may take in all, so it never delays a session start past it. */
export const PROBE_TIMEOUT_MS = 5000;
/** How long `outcome` has to decide a verdict once the agent exited. */
export const OUTCOME_BUDGET_MS = 2000;
const OUTCOME_POLL_MS = 100;
/** `TimeoutStopSec=10s` plus a margin: how long the background reset waits for a unit to settle. */
export const RESET_BUDGET_MS = 15_000;
const RESET_POLL_MS = 500;
const SYSTEMCTL_TIMEOUT_MS = 1000;

const LOG_PREFIX = "[session-scope]";

export interface SessionScopeOutcome {
  /** systemd stopped the scope because the kernel OOM-killed a process in it. */
  oomKilled: boolean;
  /** The scope's `MemoryPeak` in bytes, or null when this systemd does not record one. */
  peakBytes: number | null;
}

/** The argv to spawn in place of `[bin, ...args]`, and the scope's unit when one was made. */
export interface ScopedCommand {
  bin: string;
  args: string[];
  unit: string | null;
}

/** Wraps one short-lived command of a session launch. See `SessionScope.commands`. */
export type CommandScopes = (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => ScopedCommand;

export interface SessionScope {
  /** Settles once this daemon run's probe has decided what `wrap` may use. Never rejects. */
  ready(): Promise<void>;
  /** The argv to spawn in place of `[bin, ...args]`, and the scope's unit when one was made. */
  wrap(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string): ScopedCommand;
  /** After the wrapped process exited: whether its scope was stopped for an OOM kill. Never throws. */
  outcome(unit: string): Promise<SessionScopeOutcome | null>;
  /**
   * One session launch's short-lived commands, each in a `--collect` scope of its own named
   * `mission-control-<instance>-<label>-<nonce>-<n>`. The nonce is minted once per call of this,
   * so a resumed session's commands never collide with a scope a previous run left active, and
   * `<n>` counts that launch's commands. Nothing reads these scopes back: an OOM stops only
   * that command, and systemd's journal records it under the unit.
   */
  commands(label: string): CommandScopes;
}

export interface SessionScopeRunResult {
  /** Null when the command timed out or could not be run at all. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SessionScopeDeps {
  platform: NodeJS.Platform;
  /** The daemon's own environment, for the probe and the startup reset. */
  env: NodeJS.ProcessEnv;
  /** This daemon's state home. Its resolved path names every scope this daemon makes. */
  stateHome: string;
  /** This process's uid, to recognise its own user manager's units. */
  uid: number | null;
  systemdRun(): string | null;
  systemctl(): string | null;
  choom(): string | null;
  socketExists(path: string): boolean;
  /** `/proc/self/cgroup`, or null when it cannot be read. */
  ownCgroup(): string | null;
  /** The runtime the probe runs `-e ""` on, with the env that keeps it in Node mode. */
  probeRuntime(): { command: string; env: NodeJS.ProcessEnv };
  run(
    bin: string,
    args: string[],
    opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
  ): Promise<SessionScopeRunResult>;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  nonce(): string;
  /**
   * Extra `-p` properties for every scope. Test-only: the Linux real-systemd test caps its
   * scopes' memory through this. Production never sets it.
   */
  extraProperties?: readonly string[];
}

/** What this daemon run's probe decided `wrap` may use. */
interface Decision {
  systemdRun: string | null;
  properties: string[];
  choom: string | null;
}

const UNWRAPPED: Decision = { systemdRun: null, properties: [], choom: null };

/** The first 8 hex characters of the SHA-256 of the resolved state home. */
export function scopeInstance(stateHome: string): string {
  let home = resolve(stateHome);
  try {
    home = realpathSync(home);
  } catch {
    // A home that does not exist yet still names itself by its spelled path.
  }
  return createHash("sha256").update(home).digest("hex").slice(0, 8);
}

/** A unit-name-safe label: the session id with its `sdk:` prefix stripped. */
export function scopeLabel(label: string): string {
  return label.replace(/^sdk:/, "").replace(/[^A-Za-z0-9_.-]/g, "_") || "session";
}

/**
 * The daemon's own unit, when it is a `.service` or `.scope` of this user's manager: the leaf
 * of the unified hierarchy's path in `/proc/self/cgroup`. Null otherwise, and then no session
 * scope is bound to it.
 */
export function daemonUnit(cgroup: string | null, uid: number | null): string | null {
  if (!cgroup || uid === null) return null;
  const line = cgroup.split("\n").find((one) => one.startsWith("0::"));
  if (!line) return null;
  const path = line.slice(3).trim();
  const manager = `/user@${uid}.service/`;
  const at = path.indexOf(manager);
  if (at < 0) return null;
  const leaf = path.slice(at + manager.length).split("/").pop() ?? "";
  return /\.(service|scope)$/.test(leaf) ? leaf : null;
}

/** `KEY=VALUE` lines from `systemctl show`. */
function parseShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

function parsePeak(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

/** A byte count in base-1024 units with one decimal, as systemd's own summary prints it. */
export function formatPeak(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** The one log line a seam writes when `outcome` says its session was stopped for an OOM kill. */
export function oomStopLine(label: string, unit: string, peakBytes: number | null): string {
  const peak = peakBytes === null ? "" : ` (peak ${formatPeak(peakBytes)})`;
  return `${LOG_PREFIX} session ${label} ran out of memory: systemd stopped ${unit}${peak}`;
}

export function createSessionScope(deps: SessionScopeDeps, options: { inert?: boolean } = {}): SessionScope {
  // Resolved on first use, never at import: this module sits in the harness registry's graph,
  // and a test file sets its home after its static imports have run.
  let instanceValue: string | null = null;
  const instance = () => (instanceValue ??= scopeInstance(deps.stateHome));
  let decision: Decision = UNWRAPPED;
  let readyPromise: Promise<void> | null = null;

  const unitName = (label: string) =>
    `mission-control-${instance()}-${scopeLabel(label)}-${deps.nonce()}`;

  const scopeArgs = (unit: string, properties: readonly string[], collect: boolean) => [
    "--user",
    "--scope",
    "--quiet",
    ...(collect ? ["--collect"] : []),
    `--unit=${unit}`,
    `--slice=${SESSIONS_SLICE}`,
    ...properties.flatMap((property) => ["-p", property]),
  ];

  /** One probe: a throwaway `--collect` scope with `properties`, running `<runtime> -e ""`. */
  async function probe(systemdRun: string, properties: string[], deadline: number): Promise<"ok" | "refused" | "timeout"> {
    const timeoutMs = deadline - deps.now();
    if (timeoutMs <= 0) return "timeout";
    const runtime = deps.probeRuntime();
    const result = await deps.run(
      systemdRun,
      [...scopeArgs(unitName("probe"), properties, true), "--", runtime.command, "-e", ""],
      { timeoutMs, env: { ...deps.env, ...runtime.env } },
    );
    if (result.code === 0) return "ok";
    return result.code === null && deps.now() >= deadline ? "timeout" : "refused";
  }

  async function decide(): Promise<{ decision: Decision; problems: string[]; off: string | null }> {
    const choom = deps.choom();
    const problems: string[] = [];
    if (!choom) problems.push("choom was not found, so oom_score_adj is unchanged");
    const systemdRun = deps.systemdRun();
    if (!systemdRun || !userManagerReachable(deps.env, deps.socketExists)) {
      const why = !systemdRun ? "systemd-run was not found" : "no systemd user manager is reachable";
      return { decision: { systemdRun: null, properties: [], choom }, problems, off: why };
    }
    const bound = daemonUnit(deps.ownCgroup(), deps.uid);
    if (!bound) {
      problems.push("the daemon is not in a unit of the user manager, so stopping it does not stop its session scopes");
    }
    const base = [
      "TimeoutStopSec=10s",
      ...(bound ? [`BindsTo=${bound}`, `After=${bound}`] : []),
      ...(deps.extraProperties ?? []),
    ];
    const deadline = deps.now() + PROBE_TIMEOUT_MS;
    const full = ["OOMPolicy=stop", ...base];
    const first = await probe(systemdRun, full, deadline);
    if (first === "ok") return { decision: { systemdRun, properties: full, choom }, problems, off: null };
    if (first === "timeout") return { decision: { systemdRun: null, properties: [], choom }, problems, off: "the systemd-run probe timed out" };
    const second = await probe(systemdRun, base, deadline);
    if (second === "ok") {
      problems.unshift("this systemd refused OOMPolicy=stop, so an OOM kill may not stop a whole session");
      return { decision: { systemdRun, properties: base, choom }, problems, off: null };
    }
    const off = second === "timeout" ? "the systemd-run probe timed out" : "this systemd refused the session scope's properties";
    return { decision: { systemdRun: null, properties: [], choom }, problems, off };
  }

  /** Reset this instance's failed scopes a previous run of this daemon left behind. Never another's. */
  async function resetStale(): Promise<void> {
    const systemctl = deps.systemctl();
    if (!systemctl || !userManagerReachable(deps.env, deps.socketExists)) return;
    await deps.run(systemctl, ["--user", "reset-failed", `mission-control-${instance()}-*.scope`], {
      timeoutMs: SYSTEMCTL_TIMEOUT_MS,
      env: deps.env,
    });
  }

  async function start(): Promise<void> {
    if (deps.platform !== "linux") return;
    void resetStale().catch(() => {});
    const unscoped = (off: string) => ({
      decision: { systemdRun: null, properties: [], choom: deps.choom() },
      problems: [],
      off,
    });
    let decided: Awaited<ReturnType<typeof decide>>;
    try {
      // Each probe already runs under the remaining budget. The race is what makes the bound
      // hold whatever a probe does: a decision that arrives after it is never applied.
      decided = await Promise.race([
        decide(),
        deps.sleep(PROBE_TIMEOUT_MS).then(() => unscoped("the systemd-run probe timed out")),
      ]);
    } catch {
      decided = unscoped("the systemd-run probe failed");
    }
    decision = decided.decision;
    if (decided.off) {
      const choom = decision.choom
        ? `agents run in the daemon's cgroup with oom_score_adj ${SESSION_OOM_SCORE_ADJ} through choom`
        : "agents run in the daemon's cgroup, and choom was not found, so oom_score_adj is unchanged";
      deps.log(`${LOG_PREFIX} session isolation is off: ${decided.off}; ${choom}`);
    } else if (decided.problems.length > 0) {
      deps.log(`${LOG_PREFIX} session isolation is partial: ${decided.problems.join("; ")}`);
    }
  }

  async function show(systemctl: string, unit: string): Promise<Record<string, string> | null> {
    const result = await deps.run(
      systemctl,
      ["--user", "show", unit, "-p", "ActiveState", "-p", "Result", "-p", "MemoryPeak"],
      { timeoutMs: SYSTEMCTL_TIMEOUT_MS, env: deps.env },
    );
    if (result.code !== 0) return null;
    const fields = parseShow(result.stdout);
    return fields.ActiveState ? fields : null;
  }

  const settled = (state: string | undefined) => state === "failed" || state === "inactive";

  /** Reset `unit` once systemd has finished stopping it, or leave it to the next startup reset. */
  async function resetWhenSettled(systemctl: string, unit: string, first: Record<string, string>): Promise<void> {
    const deadline = deps.now() + RESET_BUDGET_MS;
    let read: Record<string, string> | null = first;
    while (!settled(read?.ActiveState)) {
      if (deps.now() >= deadline) return;
      await deps.sleep(RESET_POLL_MS);
      read = await show(systemctl, unit);
    }
    await deps.run(systemctl, ["--user", "reset-failed", unit], { timeoutMs: SYSTEMCTL_TIMEOUT_MS, env: deps.env });
  }

  /** `[bin, ...args]` under `choom` and in a scope named by `unit`, as far as this run's decision allows. */
  function wrapIn(
    bin: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    unit: () => string,
    collect: boolean,
  ): ScopedCommand {
    const unwrapped = { bin, args: [...args], unit: null };
    if (options.inert || deps.platform !== "linux") return unwrapped;
    const inner = decision.choom
      ? { bin: decision.choom, args: ["-n", String(SESSION_OOM_SCORE_ADJ), "--", bin, ...args] }
      : unwrapped;
    // The manager is asked about the env the child gets, as `inUserScope` does: that is what
    // `systemd-run` will reach it with.
    if (!decision.systemdRun || !userManagerReachable(env, deps.socketExists)) {
      return { bin: inner.bin, args: inner.args, unit: null };
    }
    const name = unit();
    return {
      bin: decision.systemdRun,
      args: [...scopeArgs(name, decision.properties, collect), "--", inner.bin, ...inner.args],
      unit: `${name}.scope`,
    };
  }

  return {
    ready() {
      if (options.inert) return Promise.resolve();
      readyPromise ??= start().catch(() => {});
      return readyPromise;
    },

    wrap(bin, args, env, label) {
      return wrapIn(bin, args, env, () => unitName(label), false);
    },

    commands(label) {
      let launch: string | null = null;
      let count = 0;
      return (bin, args, env) => wrapIn(bin, args, env, () => `${(launch ??= unitName(label))}-${++count}`, true);
    },

    async outcome(unit) {
      if (options.inert) return null;
      try {
        const systemctl = deps.systemctl();
        if (!systemctl) return null;
        const deadline = deps.now() + OUTCOME_BUDGET_MS;
        let read = await show(systemctl, unit);
        if (!read) return null;
        // `oom-kill` is final the moment it is read. Anything else on a unit that has not
        // settled may still turn into it: when the kernel SIGKILLs the agent itself, its exit can
        // reach the daemon before systemd has handled the cgroup's OOM event.
        while (read.Result !== "oom-kill" && !settled(read.ActiveState) && deps.now() < deadline) {
          await deps.sleep(OUTCOME_POLL_MS);
          read = (await show(systemctl, unit)) ?? read;
        }
        const verdict = { oomKilled: read.Result === "oom-kill", peakBytes: parsePeak(read.MemoryPeak) };
        void resetWhenSettled(systemctl, unit, read).catch(() => {});
        return verdict;
      } catch {
        return null;
      }
    },
  };
}

function readOwnCgroup(): string | null {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return null;
  }
}

/** The production deps. Exported so a test can build on them with its own instance. */
export const productionSessionScopeDeps: SessionScopeDeps = {
  platform: process.platform,
  env: process.env,
  // The same resolution as `config.ts`'s `STATE_DIR`, read when first asked rather than when
  // this module loads, for the reason `createSessionScope` gives.
  get stateHome() {
    return stateDir();
  },
  uid: process.getuid?.() ?? null,
  systemdRun: () => locateExecutableSync("systemd-run")?.path ?? null,
  systemctl: () => locateExecutableSync("systemctl")?.path ?? null,
  choom: () => locateExecutableSync("choom")?.path ?? null,
  socketExists,
  ownCgroup: readOwnCgroup,
  probeRuntime: () => resolveCurrentOwnedRuntime(process.execPath),
  run: async (bin, args, opts) => {
    const result = await run(bin, args, opts);
    // A child that died rather than answered, our own timeout included, reports no code.
    return { code: result.outcomeUnknown ? null : result.code, stdout: result.stdout, stderr: result.stderr };
  },
  log: (line) => console.warn(line),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms).unref?.()),
  now: () => Date.now(),
  nonce: () => randomBytes(4).toString("hex"),
};

/**
 * The daemon's session scope.
 *
 * Under the test runner it wraps nothing, the boundary `launchHome` draws in
 * `terminal/home.ts`: a test worker, and a daemon that inherits its test-runner signal, never
 * creates a scope in the operator's user manager. Tests that need the wrapping build their own
 * with `createSessionScope`. Like `openDb`, this is not a sandbox: a daemon spawned with that
 * signal scrubbed wraps for real, under the `<instance>` of its own state home, so its scopes
 * and its startup reset stay apart from the operator's.
 */
export const sessionScope: SessionScope = createSessionScope(productionSessionScopeDeps, {
  inert: underTestRunner(),
});
