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
// refused, so there is nothing to reconcile there.
test("a host without the terminal runtime has no managed resumes to reconcile", () => {
  assert.equal(reconcileManagedResumesOnHost("win32"), null);
});

test(
  "a host with the terminal runtime reconciles its managed resumes",
  { skip: skipOnWin32("the terminal runtime is unavailable on win32, so the host reconciles nothing") },
  () => {
    assert.deepEqual(reconcileManagedResumesOnHost(process.platform), []);
  },
);
