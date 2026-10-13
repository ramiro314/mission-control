import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EMULATOR_IDS, MULTIPLEXER_IDS } from "../src/shared/terminal.ts";
import {
  GHOSTTY_BIN,
  ITERM_BIN,
  MACOS_ONLY_REASON,
  WEZTERM_BIN,
  binUnsupportedReason,
} from "../src/server/terminal/bin.ts";
import { CMUX_BIN } from "../src/server/terminal/cmux.ts";
import { launchHome, type HomeDeps } from "../src/server/terminal/home.ts";
import { EMULATORS, MULTIPLEXERS, automaticFocusEmulator } from "../src/server/terminal/registry.ts";
import { terminalTargetViews } from "../src/server/terminal/targets.ts";
import { cmuxStarter } from "../src/server/setup/service.ts";
import type { BinSpec } from "../src/server/terminal/types.ts";

// iTerm2 is driven through Apple Events and cmux is a macOS app, so off macOS both say so
// instead of reading "not installed", and nothing recommends or starts them. Ghostty is
// supported on both platforms and carries no reason. Every case runs on an injected
// platform, so ubuntu CI pins macOS too.

const PLATFORMS = ["darwin", "linux"] as const;

function onPlatform(platform: NodeJS.Platform): (spec: BinSpec) => string | null {
  return (spec) => binUnsupportedReason(spec, platform);
}

test("iTerm2 and cmux require macOS; Ghostty and WezTerm carry no reason on either platform", () => {
  for (const spec of [ITERM_BIN, CMUX_BIN]) {
    assert.equal(binUnsupportedReason(spec, "darwin"), null);
    assert.equal(binUnsupportedReason(spec, "linux"), MACOS_ONLY_REASON);
  }
  for (const platform of PLATFORMS) {
    assert.equal(binUnsupportedReason(GHOSTTY_BIN, platform), null);
    assert.equal(binUnsupportedReason(WEZTERM_BIN, platform), null);
  }
  assert.equal(MACOS_ONLY_REASON, "requires macOS");
});

test("an operator override that resolves is taken on trust off macOS; one naming nothing is not", () => {
  // The e2e suite drives its fake cmux on Linux CI through exactly this override.
  try {
    process.env.MISSION_CMUX_BIN = process.execPath;
    assert.equal(binUnsupportedReason(CMUX_BIN, "linux"), null);
    process.env.MISSION_CMUX_BIN = join(tmpdir(), "mission-no-such-cmux");
    assert.equal(binUnsupportedReason(CMUX_BIN, "linux"), MACOS_ONLY_REASON);
  } finally {
    delete process.env.MISSION_CMUX_BIN;
  }
});

test("terminal pickers keep the fixed list and disable iTerm2 and cmux with the reason on Linux only", () => {
  for (const platform of PLATFORMS) {
    const views = terminalTargetViews({
      multiplexers: MULTIPLEXERS,
      emulators: EMULATORS,
      installed: () => false,
      unsupported: onPlatform(platform),
      launchId: () => "abc123",
      focusEmulator: automaticFocusEmulator,
    });
    const unavailable = Object.fromEntries(views.map((view) => [view.id, view.unavailable]));
    assert.deepEqual(views.map((view) => view.id), [...MULTIPLEXER_IDS, ...EMULATOR_IDS]);
    if (platform === "darwin") {
      assert.equal(unavailable.iterm, "iTerm2 is not installed");
      assert.equal(unavailable.cmux, "cmux is not installed");
    } else {
      assert.equal(unavailable.iterm, MACOS_ONLY_REASON);
      assert.equal(unavailable.cmux, MACOS_ONLY_REASON);
    }
    assert.equal(unavailable.ghostty, "Ghostty is not installed");
  }
});

test("the dispatch error recommends only backends this platform can run", async () => {
  const errors: Record<string, string | undefined> = {};
  for (const platform of PLATFORMS) {
    const deps: HomeDeps = {
      multiplexers: MULTIPLEXERS,
      emulators: EMULATORS,
      installed: () => false,
      unsupported: onPlatform(platform),
      focusEmulator: automaticFocusEmulator,
    };
    const result = await launchHome({ name: "api", cwd: "/tmp", argv: ["true"], sidePane: false }, deps);
    errors[platform] = result.ok ? undefined : result.error;
  }
  assert.equal(
    errors.darwin,
    "no terminal backend can host a dispatched agent - install one of tmux, herdr, cmux, wezterm, ghostty, iterm",
  );
  assert.equal(
    errors.linux,
    "no terminal backend can host a dispatched agent - install one of tmux, herdr, wezterm, ghostty",
  );
});

test("a cmux setup service is refused off macOS before it runs, and runs on macOS", async () => {
  let started = 0;
  const start = async () => {
    started += 1;
    return { ok: true as const, outcomeUnknown: false };
  };
  assert.deepEqual(await cmuxStarter(start, "linux")(), {
    ok: false,
    error: "cmux requires macOS",
    outcomeUnknown: false,
  });
  assert.equal(started, 0);
  assert.deepEqual(await cmuxStarter(start, "darwin")(), { ok: true, outcomeUnknown: false });
  assert.equal(started, 1);
});
