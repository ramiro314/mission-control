// Clear a stored base branch that names its origin's default, once, at startup.
//
// Task writes store origin's default as null (`resolveBaseBranch`), and the backlog card labels
// any non-null base. Two kinds of row escape that rule: one written before the rule existed
// (a task filed through the API or MCP with `baseBranch: "main"`), and one whose origin has
// since moved its default onto the branch the task names. Saving the editor unchanged cannot
// fix either, because the form sends only what changed. So the daemon asks origin again for
// each distinct (repository, branch) a backlog task names, and clears the ones that are now
// the default.
//
// Backlog only: a task that has left it can no longer change a provisioning field, and its base
// already did its work at dispatch. Anything uncertain - a refusal, an unreachable origin, an
// origin that advertises no HEAD - leaves the row exactly as it is.

import type { UpdateTask } from "@shared/protocol.ts";
import type { Task } from "@shared/types.ts";
import { resolveBaseBranch } from "./git/remote-default.ts";

export interface BaseBranchBackfillTasks {
  list(): Task[];
  update(id: string, patch: UpdateTask): Promise<{ ok: boolean; error?: string }>;
}

/** Clear every backlog task's stored base that origin now advertises as its default. */
export async function clearStoredDefaultBaseBranches(
  tasks: BaseBranchBackfillTasks,
  resolve: typeof resolveBaseBranch = resolveBaseBranch,
): Promise<string[]> {
  const pending = tasks.list().filter((task) => task.status === "backlog" && task.baseBranch);
  const answers = new Map<string, Promise<boolean>>();
  const isDefault = (repoRoot: string, branch: string): Promise<boolean> => {
    const key = `${repoRoot}\0${branch}`;
    let answer = answers.get(key);
    if (!answer) {
      answer = resolve(repoRoot, branch).then((r) => r.ok && r.baseBranch === null, () => false);
      answers.set(key, answer);
    }
    return answer;
  };
  const cleared: string[] = [];
  for (const { id, repoRoot, baseBranch } of pending) {
    if (!(await isDefault(repoRoot, baseBranch!))) continue;
    // Re-read, against the values captured before the wait: the row may have moved meanwhile.
    const current = tasks.list().find((t) => t.id === id);
    if (current?.status !== "backlog" || current.repoRoot !== repoRoot || current.baseBranch !== baseBranch) {
      continue;
    }
    const updated = await tasks.update(id, { baseBranch: null });
    if (updated.ok) cleared.push(id);
  }
  return cleared;
}
