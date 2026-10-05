import { basename, isAbsolute } from "node:path";
import { kindMissionMcpRequirement } from "./mission-mcp.ts";
import { missionToolsAvailability } from "./mission-tools.ts";
import { capabilitiesFor, harnessUnsupportedWhy } from "@shared/harness-capabilities.ts";
import type { AgentType, TaskKind } from "@shared/types.ts";
import { resolveTaskAgent } from "./harnesses.ts";
import { hostPlatform } from "./platform/host.ts";
import { listRepos, resolveTaskRepoRoot, resolveTaskRepoSet } from "./repos.ts";

export type PreparedTaskRepositories =
  | { ok: true; repoRoot: string; extraRepoRoots: string[]; agent: AgentType }
  | { ok: false; status: 400 | 409; error: string };

export interface PrepareTaskRepositoriesInput {
  primary: string;
  extras: readonly string[];
  kind: TaskKind;
  agent?: AgentType | null;
  shortNameSelectors: "none" | "all" | "extras";
  /** The host platform harness availability is read for; defaults to this daemon's. */
  platform?: NodeJS.Platform;
}

async function resolveSelector(selector: string): Promise<
  | { ok: true; path: string }
  | { ok: false; status: 400 | 409; error: string }
> {
  if (isAbsolute(selector)) return { ok: true, path: selector };

  const matches = (await listRepos()).filter((repo) => basename(repo) === selector);
  const candidates = new Set<string>();
  for (const match of matches) {
    const resolved = await resolveTaskRepoRoot(match);
    if (resolved.ok) candidates.add(resolved.repoRoot);
  }
  const canonical = [...candidates].sort();
  if (canonical.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `no local repository named "${selector}"; use an absolute repository path`,
    };
  }
  if (canonical.length > 1) {
    return {
      ok: false,
      status: 409,
      error:
        `repository name "${selector}" is ambiguous; use one of these absolute paths: ` +
        canonical.join(", "),
    };
  }
  return { ok: true, path: canonical[0]! };
}

/**
 * Resolve one repository selector the way `create_task`'s `repository` is resolved - an
 * absolute path, or a unique repository directory name - to its canonical repository root.
 * 400 when nothing matches, 409 when a name is ambiguous. No kind or harness policy applies:
 * this names a repository, it does not prepare a task for one.
 */
export async function resolveRepositorySelector(selector: string): Promise<
  | { ok: true; repoRoot: string }
  | { ok: false; status: 400 | 409; error: string }
> {
  const selected = await resolveSelector(selector);
  if (!selected.ok) return selected;
  const resolved = await resolveTaskRepoRoot(selected.path);
  if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };
  return { ok: true, repoRoot: resolved.repoRoot };
}

/**
 * Resolve a task's complete repository set and the harness that must be able to reach it.
 * Git identity stays in `repos.ts`; this module only coordinates selector addressing with
 * the existing task-kind default and multi-repository capability policy.
 */
export async function prepareTaskRepositories(
  input: PrepareTaskRepositoriesInput,
): Promise<PreparedTaskRepositories> {
  const selectors = [input.primary, ...input.extras];
  const paths: string[] = [];
  for (const [index, selector] of selectors.entries()) {
    const allowShortName =
      input.shortNameSelectors === "all" ||
      (input.shortNameSelectors === "extras" && index > 0);
    if (!allowShortName || isAbsolute(selector)) {
      paths.push(selector);
      continue;
    }
    const resolved = await resolveSelector(selector);
    if (!resolved.ok) return resolved;
    paths.push(resolved.path);
  }

  const resolved = await resolveTaskRepoSet(paths[0]!, paths.slice(1));
  if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };

  const agent = resolveTaskAgent(input.kind, input.agent);
  const hostUnsupported = harnessUnsupportedWhy(agent, input.platform ?? hostPlatform());
  if (hostUnsupported) return { ok: false, status: 400, error: hostUnsupported };
  if (resolved.extraRepoRoots.length > 0 && !capabilitiesFor(agent).multiRepoDispatch) {
    return {
      ok: false,
      status: 400,
      error: `${agent} cannot be given write access to more than one repo`,
    };
  }
  if (kindMissionMcpRequirement({ kind: input.kind, workflowId: null }, null)) {
    const tools = await missionToolsAvailability(agent);
    if (!tools.available) return { ok: false, status: 400, error: tools.reason! };
  }
  return { ...resolved, agent };
}
