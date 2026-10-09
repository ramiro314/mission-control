import assert from "node:assert/strict";
import test from "node:test";

import type { NativeCheckJobBinding } from "../src/server/process-inspection-native.ts";
import { createWin32CheckGroups, WIN32_CHECK_JOBS_UNAVAILABLE } from "../src/server/workflows/check-group-win32.ts";

/**
 * The win32 check group policy over a faked job binding, so it runs on every platform. What
 * the real jobs do with real processes is in `process-inspection-native.test.ts`, and the whole
 * supervisor over them in `workflow-check-supervisor.test.ts`.
 */

const ERROR_ACCESS_DENIED = 5;
const ERROR_ALREADY_EXISTS = 183;

/** Jobs as the addon keeps them: one per pid, holding a count of live processes. */
function fakeJobs() {
  const jobs = new Map<number, number>();
  const calls: string[] = [];
  const failures: { assign?: { failed: string; code: number }; active?: { failed: string; code: number }; terminate?: { failed: string; code: number } } = {};
  const binding: NativeCheckJobBinding = {
    jobAssign(pid) {
      calls.push(`assign ${pid}`);
      if (failures.assign) return failures.assign;
      if (jobs.has(pid)) return { failed: "existing job", code: ERROR_ALREADY_EXISTS };
      jobs.set(pid, 1);
      return true;
    },
    jobActive(pid) {
      calls.push(`active ${pid}`);
      if (failures.active) return failures.active;
      return jobs.get(pid) ?? null;
    },
    jobTerminate(pid) {
      calls.push(`terminate ${pid}`);
      if (failures.terminate) return failures.terminate;
      if (!jobs.has(pid)) return false;
      jobs.set(pid, 0);
      return true;
    },
    jobRelease(pid) {
      calls.push(`release ${pid}`);
      return jobs.delete(pid);
    },
  };
  return { binding, jobs, calls, failures };
}

test("a win32 group has no grace: there is nothing gentler than ending the job", () => {
  assert.equal(createWin32CheckGroups(() => fakeJobs().binding).graceful, false);
});

test("an established group answers while its job holds a process, and is released once it holds none", () => {
  const { binding, jobs, calls } = fakeJobs();
  const groups = createWin32CheckGroups(() => binding);
  assert.equal(groups.establish(4242), null);
  assert.equal(groups.answers(4242), true, "the supervisor itself is in the job");

  jobs.set(4242, 2);
  assert.equal(groups.answers(4242), true, "a descendant outliving the supervisor still answers");

  jobs.set(4242, 0);
  assert.equal(groups.answers(4242), false, "an empty job is proof of emptiness");
  assert.equal(jobs.has(4242), false, "and an empty job is released at once: nothing can enter it again");
  assert.equal(groups.answers(4242), false, "a group this daemon holds no job for has nothing in it");
  assert.deepEqual(calls.filter((call) => call.startsWith("release")), ["release 4242"]);
});

test("a job query that fails is never proof of emptiness", () => {
  const { binding, jobs, failures } = fakeJobs();
  const groups = createWin32CheckGroups(() => binding);
  assert.equal(groups.establish(7), null);
  failures.active = { failed: "QueryInformationJobObject", code: ERROR_ACCESS_DENIED };
  assert.equal(groups.answers(7), true);
  assert.equal(jobs.has(7), true, "and the job is kept");
});

test("a pid whose earlier job still holds a process is refused, and one whose job emptied is reused", () => {
  const { binding, jobs } = fakeJobs();
  const groups = createWin32CheckGroups(() => binding);
  assert.equal(groups.establish(99), null);

  // Two groups answering to one pid would let a probe of one prove the other empty.
  const refused = groups.establish(99);
  assert.match(refused ?? "", /could not be placed in a job object: existing job failed with code 183/);
  assert.equal(jobs.get(99), 1, "the live job is untouched");

  jobs.set(99, 0);
  assert.equal(groups.establish(99), null, "an emptied job frees its pid");
  assert.equal(jobs.get(99), 1);
});

test("a supervisor the job cannot take is refused with the reason", () => {
  const { binding, failures } = fakeJobs();
  failures.assign = { failed: "AssignProcessToJobObject", code: ERROR_ACCESS_DENIED };
  assert.equal(
    createWin32CheckGroups(() => binding).establish(5),
    "the check supervisor could not be placed in a job object: AssignProcessToJobObject failed with code 5",
  );
});

test("every signal ends the job, and its errors read as process.kill's", () => {
  const { binding, jobs, calls, failures } = fakeJobs();
  const groups = createWin32CheckGroups(() => binding);
  assert.equal(groups.establish(11), null);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    jobs.set(11, 3);
    groups.signal(11, signal);
    assert.equal(jobs.get(11), 0, `${signal} terminated the job`);
  }
  assert.deepEqual(calls.filter((call) => call.startsWith("terminate")), ["terminate 11", "terminate 11"]);

  assert.throws(() => groups.signal(12, "SIGKILL"), { code: "ESRCH" }, "no job, no group");
  failures.terminate = { failed: "TerminateJobObject", code: ERROR_ACCESS_DENIED };
  assert.throws(() => groups.signal(11, "SIGKILL"), { code: "EPERM" }, "a refusal may leave the group alive");
});

test("an abandoned supervisor's job is released, which ends whatever it held", () => {
  const { binding, jobs } = fakeJobs();
  const groups = createWin32CheckGroups(() => binding);
  assert.equal(groups.establish(21), null);
  groups.abandon(21);
  assert.equal(jobs.has(21), false);
});

test("without the addon nothing can be established, and nothing answers", () => {
  let loads = 0;
  const groups = createWin32CheckGroups(() => {
    loads += 1;
    throw new Error("Cannot find module 'dist/native/process-inspection.node'");
  });
  assert.equal(groups.establish(31), WIN32_CHECK_JOBS_UNAVAILABLE);
  // No job could ever have been created, so there is no group for anything to answer on.
  assert.equal(groups.answers(31), false);
  assert.throws(() => groups.signal(31, "SIGKILL"), { code: "ESRCH" });
  assert.doesNotThrow(() => groups.abandon(31));
  assert.equal(loads, 1, "the load is tried once and its outcome kept");
});
