import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { skipOnWin32 } from "./helpers/win32-skip.ts";

const home = mkdtempSync(join(tmpdir(), "mission-managed-resume-host-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { reconcileManagedResumesOnHost } = await import("../src/server/harness/resume.ts");

// Managed resumes reopen a conversation in the terminal runtime. On win32 that runtime is
// refused, and the journal's POSIX owner and mode checks can never pass there, so the daemon
// reported a journal needing inspection at boot and every 30 seconds after.
test("a host without the terminal runtime has no managed resumes to reconcile", () => {
  assert.equal(reconcileManagedResumesOnHost("win32"), null);
});

test(
  "a host with the terminal runtime reconciles its managed resumes",
  { skip: skipOnWin32("the journal pins POSIX uid and mode bits; the terminal runtime is unavailable on win32") },
  () => {
    assert.deepEqual(reconcileManagedResumesOnHost(process.platform), []);
  },
);
