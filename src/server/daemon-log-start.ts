import { startDaemonLog } from "./daemon-log.ts";

/**
 * Start the daemon's own `daemon.log` (see `daemon-log.ts`). Imported for its side effect by
 * the daemon's entry point ONLY, directly below the state-dir migration: below it, so the log
 * opens in the state dir the daemon will actually use, and above everything else, so output
 * from the rest of startup, a state-lock refusal included, reaches the file. A test that
 * imported this would tee its own worker's output into a state home. The entry calls
 * `allowRotation()` once it owns the state.
 */
export const daemonLog = startDaemonLog();
