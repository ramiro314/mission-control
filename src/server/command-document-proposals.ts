import { randomUUID } from "node:crypto";
import {
  COMMAND_DOCUMENT_PROPOSAL_MAX_BYTES,
  type CommandDocument,
  type CommandDocumentProposal,
} from "@shared/command-document.ts";
import { taskRepoRefs } from "@shared/task-repos.ts";
import type { Session, Task } from "@shared/types.ts";
import { realpathOr } from "./util/repo-doc.ts";
import type { WorkflowStore } from "./workflows/store.ts";

// Pending Command document proposals: the agent half of "two producers, one screen".
//
// `propose_command_document` hands the daemon a document for one of the calling session's own
// task repositories. Nothing here writes a live row. A proposal is stored, one per repository, a
// newer one replacing the older, and published to every window, where Library › Commands draws it
// as a banner and the attention inbox lists it. The operator opens it in the same preview an
// import gets and applies or dismisses it there; either clears it.
//
// That approval step bounds what an agent may do THROUGH MCP and nothing more. The apply route is
// under `/api/*`, which accepts any loopback caller without a token, so an agent's shell could call
// it directly (docs/security.md). Proposals are machine state rather than configuration, and no
// settings backup domain reads them.

/** The Mission MCP tool an agent session proposes a Command document with. */
export const PROPOSE_COMMAND_DOCUMENT_TOOL = "propose_command_document" as const;

/** A repository slot as the task's repository manifest issues it: `repo-01` is the primary. */
const REPOSITORY_SLOT = /^repo-(\d{2})$/;

function repositorySlot(position: number): string {
  return `repo-${String(position + 1).padStart(2, "0")}`;
}

export type ProposalRepositoryResult =
  | { ok: true; repoRoot: string }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Which of the calling session's task repositories a proposal is for, or why it is refused.
 *
 * The scope is the session's task, never the caller's word: the same rule
 * `set_affected_tests_command` enforces, from the same task (`findSessionByEnv`, then
 * `taskForSession`), without its testing-setup label restriction. A task with one repository needs
 * no `requested`; a task with several must name one. A request names a repository as its `repo-NN`
 * slot, its main checkout or the session's checkout of it, and anything else - another
 * repository on this machine included - is refused.
 */
export function proposalRepository(
  task: Task | undefined,
  requested: string | undefined,
  realpath: (path: string) => string = realpathOr,
): ProposalRepositoryResult {
  if (!task) {
    return {
      ok: false,
      status: 403,
      error: `${PROPOSE_COMMAND_DOCUMENT_TOOL} is available only to a session running a Mission Control task.`,
    };
  }
  const refs = taskRepoRefs(task);
  const listed = refs.map((ref) => `${repositorySlot(ref.position)} (${ref.repoRoot})`).join(", ");
  if (requested === undefined) {
    if (refs.length === 1) return { ok: true, repoRoot: refs[0]!.repoRoot };
    return {
      ok: false,
      status: 400,
      error: `This task has ${refs.length} repositories; name the one the document is for: ${listed}.`,
    };
  }
  const slot = REPOSITORY_SLOT.exec(requested);
  if (slot) {
    const ref = refs[Number(slot[1]) - 1];
    if (ref) return { ok: true, repoRoot: ref.repoRoot };
  } else {
    const wanted = realpath(requested);
    for (const ref of refs) {
      const spellings = [ref.repoRoot, ref.worktreePath].filter((path): path is string => path !== null);
      if (spellings.some((path) => path === requested || realpath(path) === wanted)) {
        return { ok: true, repoRoot: ref.repoRoot };
      }
    }
  }
  return {
    ok: false,
    status: 403,
    error: `${requested} is not one of this task's repositories. A proposal can name only ${listed}.`,
  };
}

/** Where a proposal came from, as it is shown to the operator. */
export interface CommandDocumentProposalOrigin {
  task: Pick<Task, "id" | "title"> | null;
  session: Pick<Session, "id" | "name"> | null;
}

export type ProposeResult =
  | { ok: true; proposal: CommandDocumentProposal; replaced: string | null }
  | { ok: false; error: string };

/**
 * The one owner of pending proposals: it writes them, and it is the only thing that tells the
 * registry the set moved. Constructed once by the daemon and handed to the routes, so a proposal
 * and its event cannot come from two writers.
 */
export class CommandDocumentProposals {
  constructor(
    private readonly store: Pick<
      WorkflowStore,
      "listCommandDocumentProposals" | "replaceCommandDocumentProposal" | "deleteCommandDocumentProposal"
    >,
    private readonly publishSet: (proposals: CommandDocumentProposal[]) => void,
    private readonly newId: () => string = randomUUID,
  ) {
    // The registry starts empty, and a proposal outlives a restart: hand it what is stored, so
    // a window connecting to a restarted daemon still sees the banner.
    this.publish();
  }

  list(): CommandDocumentProposal[] {
    return this.store.listCommandDocumentProposals();
  }

  /** The repository's pending proposal, or null. */
  get(repoRoot: string): CommandDocumentProposal | null {
    return this.list().find((proposal) => proposal.repoRoot === repoRoot) ?? null;
  }

  /** Store a validated document as the repository's pending proposal, replacing any older one. */
  propose(
    repoRoot: string,
    document: CommandDocument,
    origin: CommandDocumentProposalOrigin,
    now = Date.now(),
  ): ProposeResult {
    if (new TextEncoder().encode(JSON.stringify(document)).byteLength > COMMAND_DOCUMENT_PROPOSAL_MAX_BYTES) {
      return {
        ok: false,
        error: `A proposed Command document is at most ${COMMAND_DOCUMENT_PROPOSAL_MAX_BYTES / 1024} KiB.`,
      };
    }
    const proposal: CommandDocumentProposal = {
      id: this.newId(),
      repoRoot,
      document,
      proposedAt: now,
      taskId: origin.task?.id ?? null,
      taskTitle: origin.task?.title ?? null,
      sessionId: origin.session?.id ?? null,
      sessionName: origin.session?.name || null,
    };
    const { replaced } = this.store.replaceCommandDocumentProposal(proposal);
    this.publish();
    return { ok: true, proposal, replaced };
  }

  /**
   * Clear the repository's pending proposal, but only while it is still `id`: an apply or a
   * dismissal of a proposal a newer one replaced leaves the newer one pending. Returns whether
   * anything was cleared.
   */
  clear(repoRoot: string, id: string): boolean {
    const cleared = this.store.deleteCommandDocumentProposal(repoRoot, id);
    if (cleared) this.publish();
    return cleared;
  }

  private publish(): void {
    this.publishSet(this.list());
  }
}
