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

/**
 * What the person was looking at when a click had to `wait`: the view the click itself left
 * them on. Anything they do afterwards (another page, another selection, the Sitrep, a modal)
 * changes it, and that is the signal they have moved on.
 */
export interface TaskOpenView {
  page: string;
  selectedId: string | null;
  sitrepOpen: boolean;
  modalOpen: boolean;
}

/** A click on a task that had nowhere to land yet, kept until it does. */
export interface PendingTaskOpen {
  taskId: string;
  /** The view the click left them on. */
  view: TaskOpenView;
  /** The page the click came from, which the route still names until the navigation settles. */
  fromPage: string;
  at: number;
}

/** How long a waiting click may still move someone: a launch slower than this is not "now". */
export const PENDING_TASK_OPEN_MS = 30_000;

const sameView = (a: TaskOpenView, b: TaskOpenView): boolean =>
  a.page === b.page && a.selectedId === b.selectedId && a.sitrepOpen === b.sitrepOpen && a.modalOpen === b.modalOpen;

/**
 * Whether a waiting click may still land: `stands` while the view is exactly the one the click
 * left, and only briefly, so a slow launch never yanks someone away from what they chose next.
 * `settling` while the route still names the page the click came from (the hash change that
 * takes them to the fleet lands a tick later), so it neither lands nor is dropped yet. Anything
 * else is `drop`: they have moved on.
 */
export function pendingTaskOpenState(
  pending: PendingTaskOpen,
  view: TaskOpenView,
  now: number,
): "stands" | "settling" | "drop" {
  if (now - pending.at > PENDING_TASK_OPEN_MS) return "drop";
  if (sameView(pending.view, view)) return "stands";
  if (view.page === pending.fromPage && sameView(pending.view, { ...view, page: pending.view.page })) {
    return "settling";
  }
  return "drop";
}
