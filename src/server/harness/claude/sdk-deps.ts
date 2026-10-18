import { spawn } from "node:child_process";
import { agentSubprocessEnv, dropPaneIdentityEnv } from "../../agent-subprocess-env.ts";
import { locateExecutable } from "../../executables/locator.ts";
import { oomStopLine, sessionScope, type SessionScope } from "../../platform/session-scope.ts";
import type {
  ClaudeSdkDeps,
  ClaudeSdkOneShotDeps,
  ClaudeSdkQuery,
} from "./sdk-types.ts";

// The ONE module that imports `@anthropic-ai/claude-agent-sdk`.
//
// Everything else in the driver is written against `ClaudeSdkDeps`, so this file is where
// the vendor's surface meets ours, and where a version bump that moves that surface fails
// to compile. It owns the vendor transport and its local child identity. Projection and
// session policy stay in `sdk.ts`, which a test drives on scripted frames with these
// deps replaced; the process-boundary test uses a real vendor query and a fake CLI.

/**
 * Where the `claude` binary is, as an ABSOLUTE path this process has confirmed exists.
 *
 * PINNED, rather than left to the SDK's own detection - which falls back to the native CLI
 * shipped inside the npm package. That is a different Claude Code build from the one the
 * operator logged in with and configured, so running it silently would make "which version
 * is this session" unanswerable from the dashboard, and would ignore a `MISSION_CLAUDE_BIN`
 * pointing at a wrapper. The resolution is the harness's own chain, so an embedded session
 * and a dispatched pane launch the same binary by construction.
 *
 * Throws rather than degrades, per `SdkSpec.launch`: a driver that cannot honour what it
 * was asked for must not leave a card that looks dispatched and is running something else.
 */
export async function claudeExecutable(): Promise<string> {
  const executable = await locateExecutable("claude");
  if (!executable) throw new Error('agent binary "claude" not found in the executable environment');
  return executable.path;
}

/**
 * The subprocess environment: `process.env` minus the daemon's OWN terminal identity.
 *
 * That subtraction is load-bearing rather than tidy. Machine-installed
 * `~/.claude/settings.json` hooks fire inside this subprocess exactly as they do in a pane,
 * and `harness-hook.mjs` reports inherited pane identity as the pane it believes it is
 * running in. A daemon started from a terminal would hand its own pane down to every
 * embedded session it launches, and `findSessionByEnv` prefers a pane key over every other
 * match - so every hook from every embedded session would land on whichever card holds the
 * daemon's terminal. Dropping pane identity makes those hooks fall through to their
 * session-id match, which is the truthful one for a session that has no pane at all.
 */
export function sdkSubprocessEnv(
  base: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  stateHome?: string,
): Record<string, string | undefined> {
  const env = agentSubprocessEnv(base, { loopbackAccess: true, cwd, stateHome });
  dropPaneIdentityEnv(env);
  delete env.TERM_PROGRAM;
  return env;
}

/**
 * Load the vendor package and start a query.
 *
 * Imported lazily - the bundle is several megabytes and a daemon whose operator never turns
 * the Agent SDK runtime on should not pay for it at boot, nor should the test suite pay for
 * it on every file that reaches the harness registry. esbuild still inlines it into
 * `dist/server/index.mjs`, so this resolves nothing at runtime in a packaged build.
 */
type StartQueryParams =
  | Parameters<ClaudeSdkDeps["query"]>[0]
  | Parameters<ClaudeSdkOneShotDeps["query"]>[0];

/**
 * `startQuery` with the session scope its interactive sessions run in.
 *
 * Only an interactive session installs the spawn hook, so only it is wrapped: the agent and
 * everything it starts go in a scope of their own on Linux (`platform/session-scope.ts`), and
 * an OOM kill there stops that session rather than the daemon. Catalog probes and one-shot
 * queries keep the vendor's own spawner and stay in the daemon's cgroup.
 */
export function createClaudeSdkQuery(scope: SessionScope): (params: StartQueryParams) => Promise<ClaudeSdkQuery> {
  return (params) => startQuery(params, scope);
}

async function startQuery(params: StartQueryParams, scope: SessionScope): Promise<ClaudeSdkQuery> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  type VendorParams = Parameters<typeof query>[0];
  type VendorOptions = NonNullable<VendorParams["options"]>;

  // Spread-and-assign rather than one blanket cast, so this line is what actually checks
  // the vendor's surface: `cwd`, `pathToClaudeCodeExecutable`, `env`, `model`, `effort`,
  // `permissionMode`, `allowDangerouslySkipPermissions`, `resume`, `settingSources`,
  // `abortController`, `tools`, `settings`, `maxTurns`, `maxBudgetUsd`, `outputFormat`,
  // `stderr` and `includePartialMessages` all have to still exist upstream, with types ours
  // satisfy, or this fails to compile - which is what makes this module, and not the driver,
  // the place an SDK bump lands.
  //
  // Four fields ARE cast, and each is a place we deliberately declined to re-declare a
  // vendor type. `hooks` and `mcpServers` are `Record<string, unknown>` in our shape so a
  // test fake can build one without forty message types behind it. `prompt` carries a
  // message `content` that is a union of the Anthropic SDK's own block types. And
  // `canUseTool` differs only in `updatedPermissions`, whose elements are OPAQUE to this
  // driver by design: we hand back the exact rule set the CLI suggested, never one we
  // composed, so modelling its variants here would be re-declaring a type we never read.
  let options: VendorOptions;
  if ("canUseTool" in params.options) {
    const { hooks, mcpServers, canUseTool, ...rest } = params.options;
    options = {
      ...rest,
      canUseTool: canUseTool as unknown as VendorOptions["canUseTool"],
      hooks: hooks as VendorOptions["hooks"],
      ...(mcpServers ? { mcpServers: mcpServers as VendorOptions["mcpServers"] } : {}),
    };
  } else {
    // The one-shot surface has none of the four opaque fields above, so every option is
    // assigned directly and remains compiler-checked against the installed vendor.
    options = { ...params.options };
  }
  let recoveryProcessId: number | null = null;
  if ("canUseTool" in params.options) {
    const label = "sessionLabel" in params ? params.sessionLabel : "session";
    // The hook below must return its child synchronously, so the probe that decides what
    // `wrap` may use is awaited here, before the vendor can call it.
    await scope.ready();
    // The vendor query deliberately exposes no PID. Its supported local-spawn seam
    // lets the owning driver supply exact lifetime evidence without guessing by cwd
    // or replacing the SDK's stdin, abort, or process-cleanup protocol. The session scope
    // execs in place, so the child's pid, stdio, signals and exit are still the CLI's.
    options.spawnClaudeCodeProcess = ({ command, args: commandArgs, cwd, env, signal }) => {
      const { bin: executable, args, unit } = scope.wrap(command, commandArgs, env, label);
      const child = spawn(executable, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      recoveryProcessId = child.pid ?? null;
      if (unit) {
        child.once("exit", () => {
          void scope.outcome(unit).then((outcome) => {
            if (outcome?.oomKilled) console.warn(oomStopLine(label, unit, outcome.peakBytes));
          });
        });
      }
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data: string) => {
        options.stderr?.(data);
        if (["1", "true"].includes(env.DEBUG_CLAUDE_AGENT_SDK ?? "")) process.stderr.write(data);
      });
      return child;
    };
  }
  const started = query({
    prompt: params.prompt as VendorParams["prompt"],
    options,
  });
  Object.defineProperty(started, "recoveryProcessId", { get: () => recoveryProcessId });
  return started as unknown as ClaudeSdkQuery;
}

/** A no-turn catalog probe uses the same pinned CLI and SDK transport as a session. */
export async function startClaudeModelQuery(params: {
  prompt: AsyncIterable<import("./sdk-types.ts").ClaudeSdkUserMessage>;
  options: {
    cwd: string;
    pathToClaudeCodeExecutable: string;
    env: Record<string, string | undefined>;
    settingSources: ("user" | "project" | "local")[];
    tools: string[];
    abortController: AbortController;
  };
}): Promise<{ supportedModels(): Promise<unknown> }> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  type VendorQuery = ReturnType<typeof query>;
  type CatalogControl = Pick<VendorQuery, "supportedModels">;
  const started = await startQuery(params, sessionScope);
  return started as ClaudeSdkQuery & CatalogControl;
}

/** What the shipped driver uses. Tests replace the whole object. */
export const defaultClaudeSdkDeps: ClaudeSdkDeps = {
  query: createClaudeSdkQuery(sessionScope),
  executable: claudeExecutable,
  env: (cwd, stateHome) => sdkSubprocessEnv(process.env, cwd, stateHome),
};

/** The same lazy vendor import and binary/env answers, narrowed for one fresh query. */
export const defaultClaudeSdkOneShotDeps: ClaudeSdkOneShotDeps = {
  query: createClaudeSdkQuery(sessionScope),
  executable: claudeExecutable,
  env: (cwd) => sdkSubprocessEnv(process.env, cwd),
};
