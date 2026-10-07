import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  ensureElectronRuntime,
  probeElectronRuntime,
} from "../scripts/ensure-electron-runtime.mjs";
import { writeFakeExecutable } from "./helpers/fake-executable.ts";

const VERSION = "43.1.0-test";

/**
 * A fake package whose installer fails its first `failures` runs, as a dropped download would.
 *
 * `path.txt` names the file the preflight starts, so it names the path the fake-executable
 * helper says to start a fake by. The installer "downloads" a healthy runtime by copying every
 * file of one written ahead of time beside `dist/`, which the reinstall deletes.
 */
function fakeElectronPackage(failures = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "mission-electron-preflight-"));
  mkdirSync(join(dir, "dist"));
  mkdirSync(join(dir, "download"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: VERSION }));
  const executable = basename(writeFakeExecutable(join(dir, "dist", "fake-electron"), "process.exit(7);\n"));
  writeFakeExecutable(
    join(dir, "download", "fake-electron"),
    `process.stdout.write(${JSON.stringify(VERSION)});\n`,
  );
  writeFileSync(join(dir, "path.txt"), executable);

  writeFileSync(
    join(dir, "install.js"),
    `
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const countPath = path.join(dir, "install-count");
const count = (fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0) + 1;
fs.writeFileSync(countPath, String(count));
if (count <= ${failures}) {
  console.error("download failed");
  process.exit(1);
}
fs.cpSync(path.join(dir, "download"), path.join(dir, "dist"), { recursive: true });
fs.writeFileSync(path.join(dir, "path.txt"), ${JSON.stringify(executable)});
`,
  );
  return dir;
}

test("a runtime that exists but cannot load is reinstalled and probed again", () => {
  const dir = fakeElectronPackage();
  const logs: string[] = [];
  const logger = {
    log: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(message),
  };
  try {
    const before = probeElectronRuntime(dir);
    assert.equal(before.ok, false);
    assert.match(before.ok ? "" : before.reason, /could not load/);

    const repaired = ensureElectronRuntime(dir, { logger });
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.probe.ok, true);
    assert.equal(readFileSync(join(dir, "install-count"), "utf8"), "1");
    assert.match(logs.join("\n"), /reinstalling the generated runtime/);

    const ready = ensureElectronRuntime(dir, { logger });
    assert.equal(ready.repaired, false, "a healthy runtime is not installed twice");
    assert.equal(readFileSync(join(dir, "install-count"), "utf8"), "1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed runtime download is retried with backoff until it succeeds", () => {
  const dir = fakeElectronPackage(2);
  const logs: string[] = [];
  const sleeps: number[] = [];
  try {
    const repaired = ensureElectronRuntime(dir, {
      logger: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
      sleep: (ms) => sleeps.push(ms),
    });
    assert.equal(repaired.probe.ok, true);
    assert.equal(readFileSync(join(dir, "install-count"), "utf8"), "3");
    assert.deepEqual(sleeps, [10_000, 20_000]);
    assert.match(logs.join("\n"), /download failed \(attempt 1\/3\)/);
    assert.match(logs.join("\n"), /download failed \(attempt 2\/3\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runtime download that fails three times stops retrying and fails", () => {
  const dir = fakeElectronPackage(Infinity);
  const sleeps: number[] = [];
  try {
    assert.throws(
      () =>
        ensureElectronRuntime(dir, {
          logger: { log() {}, warn() {} },
          sleep: (ms) => sleeps.push(ms),
        }),
      /reinstall failed after 3 attempts/,
    );
    assert.equal(readFileSync(join(dir, "install-count"), "utf8"), "3");
    assert.deepEqual(sleeps, [10_000, 20_000], "no backoff after the final attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid override fails without deleting either runtime", () => {
  const dir = fakeElectronPackage();
  const override = mkdtempSync(join(tmpdir(), "mission-electron-override-"));
  writeFakeExecutable(join(override, "fake-electron"), "process.exit(9);\n");
  try {
    assert.throws(
      () =>
        ensureElectronRuntime(dir, {
          env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: override },
          logger: { log() {}, warn() {} },
        }),
      /overridden runtime failed its integrity probe/,
    );
    assert.equal(readFileSync(join(dir, "dist", "fake-electron"), "utf8").includes("exit(7)"), true);
    assert.equal(readFileSync(join(override, "fake-electron"), "utf8").includes("exit(9)"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(override, { recursive: true, force: true });
  }
});
