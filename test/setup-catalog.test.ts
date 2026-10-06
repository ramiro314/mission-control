import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVIRONMENT_ROW_METADATA,
  SETUP_DEPENDENCY_IDS,
  SETUP_DEPENDENCY_INFO,
  TERMINAL_PAIR_INFO,
  setupDependencyIdsFor,
} from "../src/shared/setup-catalog.ts";

test("the setup catalog is exhaustive, append-only, and carries usable remedies", () => {
  assert.deepEqual(Object.keys(SETUP_DEPENDENCY_INFO), [...SETUP_DEPENDENCY_IDS]);
  assert.deepEqual(
    SETUP_DEPENDENCY_IDS.slice(-8),
    ["herdr", "node-runtime", "git-for-windows", "windows-developer-mode", "windows-long-paths", "npm-script-shell", "vs-build-tools", "python3"],
    "new persisted ids append after existing entries",
  );
  assert.equal(SETUP_DEPENDENCY_INFO["gh-cli"].requirement, "required");
  assert.equal(SETUP_DEPENDENCY_INFO["gh-auth"].requirement, "required");
  assert.deepEqual(SETUP_DEPENDENCY_INFO.iterm.remedy, {
    kind: "command",
    argv: ["brew", "install", "--cask", "iterm2"],
    note: "Install iTerm2 with Homebrew.",
  });
  for (const id of SETUP_DEPENDENCY_IDS) {
    const remedy = SETUP_DEPENDENCY_INFO[id].remedy;
    if (remedy.kind === "command") {
      assert.ok(remedy.argv.length > 0, id);
      assert.ok(remedy.argv.every((part) => part.trim() === part && part.length > 0), id);
    }
    if (remedy.kind === "manual-command") {
      assert.ok(remedy.command.trim() === remedy.command && remedy.command.length > 0, id);
      assert.ok(remedy.note.length > 0, id);
    }
  }
});

test("each source owns the requirement projected onto a row", () => {
  for (const id of SETUP_DEPENDENCY_IDS) {
    assert.ok(["required", "recommended", "optional"].includes(SETUP_DEPENDENCY_INFO[id].requirement));
  }
  assert.equal(ENVIRONMENT_ROW_METADATA["upstartclaw-core-setup"].requirement, "optional");
  assert.equal(TERMINAL_PAIR_INFO.requirement, "required");
});

test("a family's host scope covers every row in it, with no per-row copy to forget", () => {
  const windowsFamily = SETUP_DEPENDENCY_IDS.filter((id) => SETUP_DEPENDENCY_INFO[id].family === "windows");
  assert.equal(windowsFamily.length, 6);
  for (const host of ["darwin", "linux"]) {
    const reported = setupDependencyIdsFor(host);
    assert.deepEqual(reported.filter((id) => windowsFamily.includes(id)), [], host);
    assert.deepEqual(reported, SETUP_DEPENDENCY_IDS.filter((id) => !windowsFamily.includes(id)), host);
  }
  assert.deepEqual(setupDependencyIdsFor("win32"), [...SETUP_DEPENDENCY_IDS]);
});
