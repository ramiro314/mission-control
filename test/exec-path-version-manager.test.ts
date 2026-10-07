import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fakeExecutablePath } from "./helpers/fake-executable.ts";
import { withProcessEnv } from "./helpers/process-env.ts";

const home = mkdtempSync(join(tmpdir(), "mission-version-manager-path-"));
process.env.HARNESS_HOME = join(home, "state");

test("configured mise, relocated asdf, and relocated Volta shims survive login-shell failure", async () => {
  const xdgDataHome = join(home, "tool-data", "xdg");
  const xdgMiseShimDir = join(xdgDataHome, "mise", "shims");
  const miseDataDir = join(home, "tool-data", "mise");
  const miseDataShimDir = join(miseDataDir, "shims");
  const miseShimDir = join(home, "tool-data", "mise-shims");
  const asdfDataDir = join(home, "tool-data", "asdf");
  const asdfShimDir = join(asdfDataDir, "shims");
  const voltaHome = join(home, "tool-data", "volta");
  const voltaBinDir = join(voltaHome, "bin");
  // Named as the platform names a tool, so the win32 ladder's PATHEXT lookup finds them too.
  const misePi = fakeExecutablePath(join(miseShimDir, "pi"));
  const miseDataPi = fakeExecutablePath(join(miseDataShimDir, "pi"));
  const xdgMisePi = fakeExecutablePath(join(xdgMiseShimDir, "pi"));
  const asdfPi = fakeExecutablePath(join(asdfShimDir, "pi"));
  const voltaPi = fakeExecutablePath(join(voltaBinDir, "pi"));
  for (const pi of [misePi, miseDataPi, xdgMisePi, asdfPi, voltaPi]) {
    mkdirSync(dirname(pi), { recursive: true });
    writeFileSync(pi, "#!/bin/sh\nexit 0\n");
    chmodSync(pi, 0o755);
  }

  try {
    await withProcessEnv(
      {
        HOME: home,
        PATH: "/usr/bin:/bin",
        SHELL: join(home, "missing-login-shell"),
        // win32 reads PATH through the PowerShell under %SystemRoot%; a missing one fails the
        // read the way the missing shell does on POSIX.
        SystemRoot: join(home, "missing-windows"),
        XDG_DATA_HOME: xdgDataHome,
        // mise's default shims sit under $XDG_DATA_HOME on POSIX and %LOCALAPPDATA% on win32.
        LOCALAPPDATA: xdgDataHome,
        APPDATA: undefined,
        MISE_DATA_DIR: miseDataDir,
        MISE_SHIMS_DIR: miseShimDir,
        ASDF_DATA_DIR: asdfDataDir,
        VOLTA_HOME: voltaHome,
      },
      async () => {
        const { refreshProcessPathFromLoginShell, resolveBinPath } =
          await import("../src/server/util/exec.ts");
        assert.equal(await resolveBinPath("pi"), misePi);
        unlinkSync(misePi);
        delete process.env.MISE_SHIMS_DIR;
        process.env.PATH = "/usr/bin:/bin";
        await refreshProcessPathFromLoginShell({ force: true });
        assert.equal(await resolveBinPath("pi"), miseDataPi);
        unlinkSync(miseDataPi);
        delete process.env.MISE_DATA_DIR;
        process.env.PATH = "/usr/bin:/bin";
        await refreshProcessPathFromLoginShell({ force: true });
        assert.equal(await resolveBinPath("pi"), xdgMisePi);
        unlinkSync(xdgMisePi);
        // asdf ships no Windows build, so the win32 row has no asdf rung and Volta is next.
        if (process.platform !== "win32") {
          assert.equal(await resolveBinPath("pi"), asdfPi);
          unlinkSync(asdfPi);
        }
        assert.equal(await resolveBinPath("pi"), voltaPi);
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
