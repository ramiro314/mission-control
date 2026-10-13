import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVIRONMENT_ROW_METADATA,
  SETUP_DEPENDENCY_IDS,
  SETUP_DEPENDENCY_INFO,
  TERMINAL_PAIR_INFO,
  setupOfferedOn,
  setupPlatform,
  setupRemedy,
  type SetupPlatform,
} from "../src/shared/setup-catalog.ts";

const PLATFORMS: readonly SetupPlatform[] = ["darwin", "linux"];

test("the setup catalog is exhaustive, append-only, and carries usable remedies", () => {
  assert.deepEqual(Object.keys(SETUP_DEPENDENCY_INFO), [...SETUP_DEPENDENCY_IDS]);
  assert.deepEqual(SETUP_DEPENDENCY_IDS.slice(-2), ["node-runtime", "lsof"], "new persisted ids append after existing entries");
  assert.equal(SETUP_DEPENDENCY_INFO["gh-cli"].requirement, "required");
  assert.equal(SETUP_DEPENDENCY_INFO["gh-auth"].requirement, "required");
  assert.deepEqual(setupRemedy(SETUP_DEPENDENCY_INFO.iterm, "darwin"), {
    kind: "command",
    argv: ["brew", "install", "--cask", "iterm2"],
    note: "Install iTerm2 with Homebrew.",
  });
  for (const id of SETUP_DEPENDENCY_IDS) {
    for (const platform of PLATFORMS) {
      const remedy = setupRemedy(SETUP_DEPENDENCY_INFO[id], platform);
      if (remedy.kind === "command") {
        assert.ok(remedy.argv.length > 0, id);
        assert.ok(remedy.argv.every((part) => part.trim() === part && part.length > 0), id);
      }
      if (remedy.kind === "instruction") {
        assert.match(remedy.package, /^[a-z0-9][a-z0-9.+-]*$/, id);
        assert.match(remedy.url, /^https:\/\//, id);
      }
    }
  }
});

test("macOS keeps its Homebrew remedies, unchanged", () => {
  const darwin = Object.fromEntries(SETUP_DEPENDENCY_IDS.flatMap((id) => {
    const remedy = setupRemedy(SETUP_DEPENDENCY_INFO[id], "darwin");
    return remedy.kind === "command" ? [[id, remedy.argv.join(" ")]] : [];
  }));
  assert.deepEqual(darwin, {
    "claude-cli": "npm install -g @anthropic-ai/claude-code",
    "pi-cli": "npm install -g @earendil-works/pi-coding-agent",
    tmux: "brew install tmux",
    wezterm: "brew install --cask wezterm",
    ghostty: "brew install --cask ghostty",
    "gh-cli": "brew install gh",
    iterm: "brew install --cask iterm2",
    "node-runtime": "brew install node",
  });
});

test("Linux is offered no Homebrew command and no cask, and keeps its npm rows", () => {
  for (const id of SETUP_DEPENDENCY_IDS) {
    const linux = setupRemedy(SETUP_DEPENDENCY_INFO[id], "linux");
    if (linux.kind === "command") {
      assert.equal(linux.argv[0], "npm", id);
      assert.deepEqual(linux, setupRemedy(SETUP_DEPENDENCY_INFO[id], "darwin"), id);
    }
    assert.doesNotMatch(JSON.stringify(linux), /brew|--cask/, id);
  }
  const instructions = Object.fromEntries(SETUP_DEPENDENCY_IDS.flatMap((id) => {
    const remedy = setupRemedy(SETUP_DEPENDENCY_INFO[id], "linux");
    return remedy.kind === "instruction" ? [[id, remedy.package]] : [];
  }));
  assert.deepEqual(instructions, {
    tmux: "tmux",
    wezterm: "wezterm",
    ghostty: "ghostty",
    "gh-cli": "gh",
    "node-runtime": "nodejs",
    lsof: "lsof",
  });
});

test("lsof is a Linux row only, and every other row is offered on both hosts", () => {
  for (const id of SETUP_DEPENDENCY_IDS) {
    const info = SETUP_DEPENDENCY_INFO[id];
    assert.equal(setupOfferedOn(info, "linux"), true, id);
    assert.equal(setupOfferedOn(info, "darwin"), id !== "lsof", id);
  }
  assert.equal(SETUP_DEPENDENCY_INFO.lsof.requirement, "required");
  assert.equal(SETUP_DEPENDENCY_INFO.lsof.family, "runtime");
});

test("every host but macOS reads the Linux remedies", () => {
  assert.equal(setupPlatform("darwin"), "darwin");
  for (const platform of ["linux", "freebsd", "win32"]) assert.equal(setupPlatform(platform), "linux");
});

test("each source owns the requirement projected onto a row", () => {
  for (const id of SETUP_DEPENDENCY_IDS) {
    assert.ok(["required", "recommended", "optional"].includes(SETUP_DEPENDENCY_INFO[id].requirement));
  }
  assert.equal(ENVIRONMENT_ROW_METADATA["upstartclaw-core-setup"].requirement, "optional");
  assert.equal(TERMINAL_PAIR_INFO.requirement, "required");
});
