/**
 * The D37 skip reason for a test that needs worktree occupancy proven: a native return,
 * destroy or prune that must go through, or a slot's process count.
 *
 * Occupancy proves a checkout idle from a process listing scoped to this user and each
 * process's working directory (`src/server/worktrees/occupancy.ts`). win32 has neither an
 * effective uid to scope that listing nor a supported cwd read, so occupancy is unknown there
 * and every destructive caller refuses, as plan M2.4 chose. The refusal itself is the win32
 * behavior; these tests pin the POSIX proof that lets the cleanup through.
 */
export const WIN32_OCCUPANCY_UNPROVABLE =
  "worktree occupancy needs a user-scoped process listing and process cwds, which win32 cannot read, so every native return, destroy and prune is refused (plan M2.4)";
