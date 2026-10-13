import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { have } from "../scripts/lib.mjs";

const repo = join(import.meta.dirname, "..");

/** A PATH directory holding only `tools`: each a symlink to the real binary, or a stub script. */
function pathWith(tools: Record<string, string>) {
  const bin = mkdtempSync(join(tmpdir(), "mission-scripts-lib-"));
  for (const [name, target] of Object.entries(tools)) {
    if (target.startsWith("#!")) {
      writeFileSync(join(bin, name), target);
      chmodSync(join(bin, name), 0o755);
    } else {
      symlinkSync(target, join(bin, name));
    }
  }
  return bin;
}

function withPath<T>(path: string, body: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return body();
  } finally {
    process.env.PATH = saved;
  }
}

test("have() finds a tool on PATH without `which` being installed", () => {
  const bin = pathWith({ "fake-tool": "#!/bin/sh\nexit 0\n" });
  try {
    withPath(bin, () => {
      assert.equal(have("which"), false);
      assert.equal(have("fake-tool"), true);
      assert.equal(have("absent-tool"), false);
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("have() treats its argument as a name, never as shell", () => {
  assert.equal(have("sh; exit 0"), false);
  assert.equal(have("$(true)"), false);
});

test("worktree setup still installs dependencies on a system without `which`", () => {
  const worktree = mkdtempSync(join(tmpdir(), "mission-worktree-setup-"));
  const marker = join(worktree, "npm-ran");
  const git = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = pathWith({
    git,
    npm: `#!/bin/sh\necho "$@" > "${marker}"\n`,
  });
  try {
    execFileSync(git, ["init", "-q", worktree]);
    writeFileSync(join(worktree, "package.json"), "{}\n");
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    const result = spawnSync(
      process.execPath,
      [join(repo, "scripts", "worktree-setup.mjs"), worktree],
      { encoding: "utf8", env: { ...process.env, PATH: bin } },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /installing dependencies \(npm ci\)/);
    assert.doesNotMatch(result.stderr, /npm not found/);
    assert.ok(existsSync(marker), "npm was never run");
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});
