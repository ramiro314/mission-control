import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AGENT_CAPABILITIES_ROOT, legacyAgentRuntimeRoot, sessionScoutCredentialDirectory } from "@shared/harness-runtime.mjs";
import { isActiveTask } from "@shared/task-status.ts";
import type { Registry } from "../registry.ts";
import { provisionSessionScoutCredential, verifyScoutSubmissionCredential } from "./submission-auth.ts";

/** Registry-owned capability projection. No client can mint authority by claiming an id. */
export function maintainScoutSessionCredentials(registry: Registry): () => void {
  const published = new Map<string, { fingerprint: string; paths: string[] }>();
  function refresh(id: string): void {
    try {
      const session = registry.getSession(id);
      if (!session || session.state === "exited" || !session.cwd) return;
      const episode = registry.workEpisodeForSession(id);
      if (!episode) return;
      const task = registry.taskForSession(id, session.cwd);
      const authority = {
        sessionId: id, episodeId: episode.episodeId,
        taskId: task && isActiveTask(task.status) ? task.id : null,
        cwd: session.cwd, pid: session.pid, agentSessionId: session.agentSessionId,
      };
      const fingerprint = JSON.stringify(authority);
      const previous = published.get(id);
      if (previous?.fingerprint === fingerprint) return;
      const paths = provisionSessionScoutCredential(authority);
      published.set(id, { fingerprint, paths });
      for (const path of previous?.paths ?? []) if (!paths.includes(path)) removeOwned(path, id);
    } catch (error) {
      console.error("[scout] could not refresh session report capability", error);
    }
  }
  function removeOwned(path: string, id: string): void {
    try {
      const authority = verifyScoutSubmissionCredential(readFileSync(path, "utf8").trim());
      if (authority?.sessionId === id) rmSync(path, { force: true });
    } catch { /* Missing files already convey no capability. */ }
  }
  const unsubscribe = registry.subscribe((event) => {
    if (event.type === "session_upsert") refresh(event.session.id);
    if (event.type === "task_upsert" && event.task.sessionId) refresh(event.task.sessionId);
    if (event.type === "session_remove") {
      for (const path of published.get(event.id)?.paths ?? []) removeOwned(path, event.id);
      published.delete(event.id);
    }
  });
  const unobserve = registry.onSessionsObserved(() => {
    // Restoration/discovery has completed before old files can be judged stale. On Linux the
    // legacy temp-dir root received copies too, so its stale ones are pruned the same way.
    // A refused current root is logged and skipped; the legacy one is still pruned.
    const directories: string[] = [];
    try {
      directories.push(sessionScoutCredentialDirectory());
    } catch (error) {
      console.error("[scout] capability reconciliation failed", error);
    }
    const legacy = legacyAgentRuntimeRoot(AGENT_CAPABILITIES_ROOT);
    if (legacy) directories.push(sessionScoutCredentialDirectory(legacy));
    for (const directory of directories) reconcileDirectory(directory);
  });
  function reconcileDirectory(directory: string): void {
    try {
      for (const name of readdirSync(directory)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        const path = join(directory, name);
        const authority = verifyScoutSubmissionCredential(readFileSync(path, "utf8").trim());
        if (authority?.sessionId) {
          if (registry.getSession(authority.sessionId)) {
            refresh(authority.sessionId);
            // Retire obsolete public-id locators and previous process locators on upgrade.
            const current = published.get(authority.sessionId);
            if (current && !current.paths.includes(path)) removeOwned(path, authority.sessionId);
          }
          else removeOwned(path, authority.sessionId);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[scout] capability reconciliation failed", error);
    }
  }
  return () => { unsubscribe(); unobserve(); };
}
