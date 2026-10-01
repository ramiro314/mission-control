import type { Session, Task } from "@shared/types.ts";
import { isTerminalTask } from "@shared/task-status.ts";

/**
 * Where opening a task lands, decided once for `App.openTask` and for the request it keeps
 * waiting on, so the click and its later completion cannot disagree.
 *
 * - `session`: its session is up. An exited session lingers in the list until it is evicted
 *   but has nothing left to show, so it never counts.
 * - `editor`: it waits in the backlog, where its editor is.
 * - `sitrep`: it finished, so its outcome is its Recent outcomes row. Only a finished task has
 *   one; the Sitrep draws no other.
 * - `wait`: it is in flight with no session to show yet (provisioning, or between an exited
 *   session and the status that follows). Nothing can be opened now, but its session or its
 *   outcome will exist shortly.
 */
export type TaskOpenTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "editor" }
  | { kind: "sitrep" }
  | { kind: "wait" };

export function taskOpenTarget(
  task: Pick<Task, "id" | "status" | "sessionId">,
  sessions: readonly Pick<Session, "id" | "state" | "task">[],
): TaskOpenTarget {
  const live = sessions.find((session) =>
    session.state !== "exited" &&
    (task.sessionId ? session.id === task.sessionId : session.task?.id === task.id));
  if (live) return { kind: "session", sessionId: live.id };
  if (task.status === "backlog") return { kind: "editor" };
  if (isTerminalTask(task.status)) return { kind: "sitrep" };
  return { kind: "wait" };
}
