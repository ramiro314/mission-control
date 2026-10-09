import {
  loadNativeCheckJobBinding,
  type NativeCheckJobBinding,
} from "../process-inspection-native.ts";
import type { CheckGroupPlatform } from "./check-group.ts";

// A workflow Check's process group on win32, which has none: a job object.
//
// Windows has no process groups, and the parent-pid tree `taskkill /T` walks is no substitute.
// It forgets a descendant the moment that descendant's parent exits, which is exactly the
// `server & exit 0` shape a check gets wrong most often, and a parent pid can name a process
// that has since been reused. A job does not forget: the supervisor is assigned to one before
// its gate opens, and every process the check command starts afterwards is created inside it,
// whatever happens to its parent. So the job answers the question a POSIX group id answers.
//
// The jobs live in `native/process-inspection`, keyed by the supervisor's pid, unnamed and with
// a handle only this process holds. They are created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
// so a job ends in exactly one of two ways: this daemon terminates it, or this daemon goes away
// and the kernel, closing its handles, terminates everything still in it. That second way is
// what POSIX needs a durable row and identity-verified recovery for, and it is why a daemon
// that holds no job for a recorded pid may report that group empty: a job only outlives the
// daemon that created it with nothing left inside.
//
// Two differences from POSIX that every caller inherits, and `check-group.ts` states where it
// relies on them:
//
//  - **No grace.** A console program has no handler a job can reach before ending it, so every
//    signal but `0` terminates the job at once. `graceful` says so, and the teardown ladder
//    skips the grace it would otherwise wait out for nothing.
//  - **A job, once empty, is released.** No process can enter an empty job (only a member
//    starts processes inside it), so the answer can never change back, and the handle is closed
//    the moment a probe sees zero members.
//
// A process that breaks away from the job escapes it, as one that calls `setsid()` escapes a
// POSIX group. The job does not allow breakaway, so only a process started outside it can.

export const WIN32_CHECK_JOBS_UNAVAILABLE =
  "check process groups need the native process inspection addon, which could not be loaded";

const ERROR_ALREADY_EXISTS = 183;

type Failure = { failed: string; code: number };

function isFailure(answer: unknown): answer is Failure {
  return typeof answer === "object" && answer !== null && typeof (answer as Failure).failed === "string";
}

function describe(answer: unknown): string {
  if (isFailure(answer)) return `${answer.failed} failed with code ${answer.code}`;
  return `an unrecognised answer (${JSON.stringify(answer)})`;
}

/** An error shaped like the one `process.kill` throws, so a caller reads one `code` everywhere. */
function killError(code: "ESRCH" | "EPERM", detail: string): Error {
  return Object.assign(new Error(`kill ${code}: ${detail}`), { code, syscall: "kill" });
}

/**
 * `loadJobs` loads the addon, or throws when it cannot. It is called at most once, on the first
 * read that needs it, and its outcome is kept, as `createWin32ProcessInspector` keeps its own.
 */
export function createWin32CheckGroups(
  loadJobs: () => NativeCheckJobBinding = loadNativeCheckJobBinding,
): CheckGroupPlatform {
  let loaded: { binding: NativeCheckJobBinding } | { unavailable: string } | undefined;
  const jobs = (): NativeCheckJobBinding | null => {
    if (!loaded) {
      try {
        loaded = { binding: loadJobs() };
      } catch (error) {
        loaded = { unavailable: error instanceof Error ? error.message : String(error) };
      }
    }
    return "binding" in loaded ? loaded.binding : null;
  };

  /**
   * Whether the job still holds a process. A job this daemon does not hold has none: see the
   * file comment. A query that fails is NOT proof of emptiness, so it answers "still there".
   */
  const answers = (binding: NativeCheckJobBinding, pid: number): boolean => {
    const active = binding.jobActive(pid);
    if (active === null) return false;
    if (typeof active !== "number") return true;
    if (active > 0) return true;
    binding.jobRelease(pid);
    return false;
  };

  return {
    graceful: false,

    establish(pid) {
      const binding = jobs();
      if (!binding) return WIN32_CHECK_JOBS_UNAVAILABLE;
      let answer = binding.jobAssign(pid);
      // A job this daemon still holds for an earlier supervisor that had the same pid. Once that
      // job is empty it is released and the pid is free again; while it is not, two groups
      // would answer to one pid, so the new one is refused, as a reused group id would be.
      if (isFailure(answer) && answer.code === ERROR_ALREADY_EXISTS && !answers(binding, pid)) {
        answer = binding.jobAssign(pid);
      }
      if (answer === true) return null;
      return `the check supervisor could not be placed in a job object: ${describe(answer)}`;
    },

    answers(pid) {
      const binding = jobs();
      return binding ? answers(binding, pid) : false;
    },

    // Every signal ends the job: there is nothing gentler to send. See `graceful`.
    signal(pid) {
      const binding = jobs();
      if (!binding) throw killError("ESRCH", WIN32_CHECK_JOBS_UNAVAILABLE);
      const answer = binding.jobTerminate(pid);
      if (answer === true) return;
      if (answer === false) throw killError("ESRCH", `no job holds pid ${pid}`);
      throw killError("EPERM", describe(answer));
    },

    abandon(pid) {
      jobs()?.jobRelease(pid);
    },
  };
}
