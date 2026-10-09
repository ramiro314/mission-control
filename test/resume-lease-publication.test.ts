import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createResumeLease, readResumeLease, reconcileResumeLeases, resumeLeaseRoot, revokeResumeLease,
  type ResumeLease } from "../src/server/terminal/resume-lease.ts";

for (const operation of ["write", "publish"] as const) test(`failed lease ${operation} cannot publish a partial journal`, (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), "resume-publication-"));
  const root = resumeLeaseRoot(home);
  const preparing = new Set<string>();
  const originalOpen = fs.openSync, originalRename = fs.renameSync;
  const injected = Object.assign(new Error("fixture I/O failure"), { code: "EIO" });
  const fault = operation === "write"
    ? t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).includes("lease.json")) throw injected;
      return originalOpen(...args);
    })
    : t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]).startsWith(join(root, "leases") + sep)) throw injected;
      return originalRename(...args);
    });
  syncBuiltinESMExports();
  try {
    assert.throws(() => createResumeLease(root, "failed", preparing), /fixture I\/O failure/);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  try {
    assert.deepEqual(fs.readdirSync(join(root, "leases")), []);
    assert.deepEqual(fs.readdirSync(join(root, "homes")), []);
    assert.equal(preparing.size, 0);
    const next = createResumeLease(root, "another-conversation", preparing);
    assert.ok(fs.existsSync(next.home), "an unrelated resume still prepares after the I/O failure");
    revokeResumeLease(next);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test("a crash before writing the lease leaves no visible malformed journal", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "resume-publication-crash-"));
  const root = resumeLeaseRoot(home);
  const module = pathToFileURL(join(process.cwd(), "src/server/terminal/resume-lease.ts")).href;
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
import {createResumeLease} from ${JSON.stringify(module)};
const open=fs.openSync;fs.openSync=(...args)=>{if(String(args[0]).includes('lease.json'))process.exit(55);return open(...args);};
syncBuiltinESMExports();createResumeLease(process.argv[1],'crashed',new Set());`;
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 55, child.stderr);
    assert.deepEqual(fs.readdirSync(join(root, "leases")), []);
    assert.deepEqual(reconcileResumeLeases(root), []);
    const recovered = createResumeLease(root, "next", new Set());
    assert.ok(fs.existsSync(recovered.home));
    revokeResumeLease(recovered);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

// A scanner that briefly holds a freshly written file refuses its rename on win32 with EPERM.
// Publication retries that refusal there through `renameAllowingHeldHandlesSync`, for the record and for the
// staging directory that carries it into `leases/`. POSIX never sees such a refusal, so it reports
// one as before. Any other refusal is reported everywhere and leaves no partial journal.
for (const step of ["record", "staging directory"] as const) for (const code of ["EPERM", "ENOENT"] as const) {
  test(`a ${step} rename refused once with ${code} is retried only when win32 holds it open`, (t) => {
    const home = fs.mkdtempSync(join(tmpdir(), "resume-publication-scanner-"));
    const root = resumeLeaseRoot(home);
    const preparing = new Set<string>();
    const originalRename = fs.renameSync;
    const refusedTarget = (to: string) => step === "record"
      ? to.endsWith(`${sep}lease.json`)
      : to.startsWith(join(root, "leases") + sep);
    let refusals = 0;
    const fault = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (refusals === 0 && refusedTarget(String(args[1]))) {
        refusals++;
        throw Object.assign(new Error(`${code}: fixture refusal`), { code });
      }
      return originalRename(...args);
    });
    syncBuiltinESMExports();
    const retried = code === "EPERM" && process.platform === "win32";
    let lease: ResumeLease | null = null;
    try {
      if (retried) lease = createResumeLease(root, "scanned", preparing);
      else assert.throws(() => createResumeLease(root, "scanned", preparing), { code });
    } finally { fault.mock.restore(); syncBuiltinESMExports(); }
    try {
      assert.equal(refusals, 1, "the fixture refused exactly one publishing rename");
      if (lease) {
        assert.equal(readResumeLease(root, lease.id).conversation, "scanned");
        assert.ok(fs.existsSync(lease.home), "the retried lease prepared its home");
        assert.ok(revokeResumeLease(lease));
      } else {
        assert.deepEqual(fs.readdirSync(join(root, "leases")), []);
        assert.deepEqual(fs.readdirSync(join(root, "homes")), []);
        assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".lease-")), [], "no staging directory is left behind");
        assert.equal(preparing.size, 0);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
  });
}
