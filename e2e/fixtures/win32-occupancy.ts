/**
 * The D37 skip reason for a test that needs worktree occupancy proven: a native return,
 * destroy or prune that must go through, or a slot's process count.
 *
 * Occupancy proves a checkout idle from a process listing scoped to this user and each
 * process's working directory (`src/server/worktrees/occupancy.ts`). On win32 the
 * `native/process-inspection` addon supplies both, but a same-user process the daemon may not
 * read (an elevated one, or one whose own DACL refuses memory reads) leaves occupancy unknown,
 * and every destructive caller refuses, as plan M2.4 chose. Whether a host has such a process is
 * not something a spec controls, and releasing a native slot on win32 past that check is task
 * 90865459. The refusal itself is the win32 behavior; these tests pin the POSIX proof that lets
 * the cleanup through.
 */
export const WIN32_OCCUPANCY_UNPROVABLE =
  "worktree occupancy on win32 stays unknown while any same-user process refuses its cwd read, so a native return, destroy or prune is refused there (plan M2.4)";
