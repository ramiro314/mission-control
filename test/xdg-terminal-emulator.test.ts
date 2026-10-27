import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";

import { EMULATOR_IDS, TERMINAL_BACKEND_IDS } from "../src/shared/terminal.ts";
import {
  binPresent,
  binUnavailableReason,
  binUnsupportedReason,
  XDG_TERMINAL_BIN,
  XDG_TERMINAL_UNSUPPORTED_REASON,
} from "../src/server/terminal/bin.ts";
import { emulatorAttemptOrder, emulatorListed, EMULATORS } from "../src/server/terminal/registry.ts";
import {
  agentHostUnavailable,
  launchAgentTerminal,
  launchTerminal,
  terminalTargetViews,
  type TerminalTargetDeps,
} from "../src/server/terminal/targets.ts";
import {
  launchDetached,
  rootedArgv,
  xdgTerminalEmulator,
  xdgTerminalLaunchers,
  type XdgTerminalLauncher,
} from "../src/server/terminal/xdg-terminal.ts";
import type { BinSpec, TerminalResult } from "../src/server/terminal/types.ts";
import { unpreparedGuiSpawn } from "../src/server/graphical-session.ts";
import type { ResolvedExecutable } from "../src/server/executables/locator.ts";
import { FIXED_OS_EXECUTABLES } from "../src/server/executables/catalog.ts";
import { MUX_BIN, OK, FAIL, fakeEmulator, fakeMultiplexer } from "./helpers/terminal-fakes.ts";
import { PLAIN_NAMES } from "../src/server/terminal/names.ts";
import { homeBackends, launchHome, type HomeDeps } from "../src/server/terminal/home.ts";

// The catalog override names a file that does not exist, so a developer's installed
// xdg-terminal-exec cannot decide what this file observes. Read at resolve time, never at import.
process.env.MISSION_XDG_TERMINAL_EXEC_BIN = join(tmpdir(), "mission-test-missing-xdg-terminal-exec");

const ATTACH = ["/usr/bin/tmux", "attach", "-t", "work"];

const XDG: XdgTerminalLauncher = { name: "xdg-terminal-exec", path: "/usr/bin/xdg-terminal-exec", env: {}, prefix: [] };
const TERM: XdgTerminalLauncher = { name: "$TERMINAL (konsole)", path: "/usr/bin/konsole", env: {}, prefix: ["-e"] };

/** The adapter over fake launchers, recording every command line it started. */
function recording(launchers: readonly XdgTerminalLauncher[], answers: Record<string, TerminalResult>) {
  const started: { argv: string[]; cwd: string | null }[] = [];
  const emulator = xdgTerminalEmulator({
    launchers: () => launchers,
    launch: async (launcher, args, opts) => {
      started.push({ argv: [launcher.path, ...launcher.prefix, ...args], cwd: opts.cwd });
      return answers[launcher.name] ?? OK;
    },
    settleMs: 0,
    prepareGui: unpreparedGuiSpawn,
  });
  return { emulator, started };
}

function resolved(path: string): ResolvedExecutable {
  return {
    id: null,
    path,
    env: { PATH: "/usr/bin" },
    source: "inherited-path",
    sourceDetail: "PATH",
    generation: 1,
    refreshedAt: "2026-10-12T00:00:00.000Z",
  };
}

test("emulator ids grow at their end, so every persisted id keeps its meaning", () => {
  assert.deepEqual([...EMULATOR_IDS], ["wezterm", "ghostty", "iterm", "xdg-terminal"]);
  assert.deepEqual(TERMINAL_BACKEND_IDS.slice(-EMULATOR_IDS.length), [...EMULATOR_IDS]);
  assert.equal(TERMINAL_BACKEND_IDS.at(-1), "xdg-terminal");
});

test("it raises through xdg-terminal-exec with the attach argv as-is", async () => {
  const { emulator, started } = recording([XDG, TERM], {});
  const opened = await emulator.spawn!.tab({ argv: ATTACH, title: "work", cwd: null });

  assert.deepEqual(opened, { ok: true, outcomeUnknown: false, target: null });
  assert.deepEqual(started, [{ argv: ["/usr/bin/xdg-terminal-exec", ...ATTACH], cwd: null }]);
});

test("a refused xdg-terminal-exec falls back to $TERMINAL -e", async () => {
  const { emulator, started } = recording([XDG, TERM], {
    "xdg-terminal-exec": FAIL("xdg-terminal-exec exited with status 1"),
  });
  const opened = await emulator.spawn!.tab({ argv: ATTACH, title: "work", cwd: null });

  assert.equal(opened.ok, true);
  assert.deepEqual(
    started.map((s) => s.argv),
    [
      ["/usr/bin/xdg-terminal-exec", ...ATTACH],
      ["/usr/bin/konsole", "-e", ...ATTACH],
    ],
  );
});

test("both refusals are reported, and an unknown outcome is never retried", async () => {
  const refused = recording([XDG, TERM], {
    "xdg-terminal-exec": FAIL("xdg-terminal-exec exited with status 1"),
    "$TERMINAL (konsole)": FAIL("$TERMINAL (konsole) exited with status 2"),
  });
  const failed = await refused.emulator.spawn!.tab({ argv: ATTACH, title: "work", cwd: null });
  assert.equal(failed.ok, false);
  assert.equal(
    failed.error,
    "xdg-terminal-exec exited with status 1; $TERMINAL (konsole) exited with status 2",
  );

  // Killed mid-launch: the window may be open, so a second launcher could open another.
  const unknown = recording([XDG, TERM], {
    "xdg-terminal-exec": { ok: false, error: "killed", outcomeUnknown: true },
  });
  const maybe = await unknown.emulator.spawn!.tab({ argv: ATTACH, title: "work", cwd: null });
  assert.equal(maybe.outcomeUnknown, true);
  assert.equal(unknown.started.length, 1);

  const none = recording([], {});
  const missing = await none.emulator.spawn!.tab({ argv: ATTACH, title: "work", cwd: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, XDG_TERMINAL_BIN.missingReason);
});

test("a dispatch is rooted in its worktree whichever terminal runs it", async () => {
  const { emulator, started } = recording([TERM], {});
  await emulator.spawn!.tab({ argv: ["/bin/claude", "--resume"], title: "api", cwd: "/w/it's here" });

  assert.deepEqual(started, [
    {
      argv: [
        "/usr/bin/konsole",
        "-e",
        FIXED_OS_EXECUTABLES.sh,
        "-c",
        'cd -- "$1" && shift && exec "$@"',
        "sh",
        "/w/it's here",
        "/bin/claude",
        "--resume",
      ],
      cwd: "/w/it's here",
    },
  ]);
  assert.deepEqual(rootedArgv(ATTACH, null), ATTACH);
});

test("the rooting wrapper really runs the command in the directory", async () => {
  const { execFileSync } = await import("node:child_process");
  const { realpathSync } = await import("node:fs");
  const dir = tmpdir();
  const out = execFileSync(rootedArgv(["pwd"], dir)[0]!, rootedArgv(["pwd"], dir).slice(1), {
    cwd: "/",
    encoding: "utf8",
  });
  // Compared as resolved paths: the wrapper's `cd` exports a logical $PWD that `pwd` prints,
  // so where the temp dir sits behind a symlink (macOS's /var -> /private/var) the same
  // directory is spelled two ways.
  assert.equal(realpathSync(out.trim()), realpathSync(dir));
});

test("launchers resolve xdg-terminal-exec first, then $TERMINAL, skipping what is absent", () => {
  const both = xdgTerminalLaunchers(
    { TERMINAL: " konsole " },
    { xdgTerminalExec: () => resolved("/usr/bin/xdg-terminal-exec"), command: (c) => resolved(`/usr/bin/${c}`) },
  );
  assert.deepEqual(
    both.map(({ name, path, prefix }) => ({ name, path, prefix })),
    [
      { name: "xdg-terminal-exec", path: "/usr/bin/xdg-terminal-exec", prefix: [] },
      { name: "$TERMINAL (konsole)", path: "/usr/bin/konsole", prefix: ["-e"] },
    ],
  );

  const onlyTerminal = xdgTerminalLaunchers(
    { TERMINAL: "konsole" },
    { xdgTerminalExec: () => null, command: (c) => resolved(`/usr/bin/${c}`) },
  );
  assert.deepEqual(onlyTerminal.map((l) => l.name), ["$TERMINAL (konsole)"]);

  // Blank is unset, and a $TERMINAL naming nothing on PATH is not a launcher.
  assert.deepEqual(
    xdgTerminalLaunchers({ TERMINAL: "  " }, { xdgTerminalExec: () => null, command: () => resolved("/x") }),
    [],
  );
  assert.deepEqual(
    xdgTerminalLaunchers({ TERMINAL: "nope" }, { xdgTerminalExec: () => null, command: () => null }),
    [],
  );
});

test("it declares only spawn: nothing an unknown terminal opened can be addressed", () => {
  const emulator = EMULATORS["xdg-terminal"];
  assert.equal(emulator.id, "xdg-terminal");
  assert.equal(emulator.label, "Default terminal");
  assert.ok(emulator.spawn);
  for (const capability of ["list", "hostProcess", "write", "capture", "focus", "restoreTarget", "retitle"] as const) {
    assert.equal(emulator[capability], null, capability);
  }
  assert.equal(emulator.names, PLAIN_NAMES);
});

test("it is supported on Linux only, and hidden rather than greyed out elsewhere", () => {
  assert.equal(binUnsupportedReason(XDG_TERMINAL_BIN, "linux"), null);
  assert.equal(binUnsupportedReason(XDG_TERMINAL_BIN, "darwin"), XDG_TERMINAL_UNSUPPORTED_REASON);

  const emulator = EMULATORS["xdg-terminal"];
  const onMac = { installed: () => true, unsupported: (spec: BinSpec) => binUnsupportedReason(spec, "darwin") };
  const onLinux = { installed: () => true, unsupported: (spec: BinSpec) => binUnsupportedReason(spec, "linux") };
  assert.equal(emulatorListed(emulator, onMac), false);
  assert.equal(emulatorListed(emulator, onLinux), true);
  // Every other emulator keeps its row on any host; only a platform's own fallback is hidden.
  for (const id of EMULATOR_IDS.filter((id) => id !== "xdg-terminal")) {
    assert.equal(emulatorListed(EMULATORS[id], onMac), true, id);
    assert.equal(emulatorListed(EMULATORS[id], onLinux), true, id);
  }
});

test("on Linux, with neither launcher, the reason names both fixes", () => {
  const reason = binUnavailableReason(XDG_TERMINAL_BIN, "Default terminal", {
    installed: () => false,
    unsupported: (spec) => binUnsupportedReason(spec, "linux"),
  });
  assert.equal(reason, "No default terminal found - install xdg-terminal-exec or set $TERMINAL");
});

test("$TERMINAL alone makes it present on Linux", { skip: process.platform !== "linux" }, () => {
  assert.equal(binPresent(XDG_TERMINAL_BIN, {}), false);
  assert.equal(binPresent(XDG_TERMINAL_BIN, { TERMINAL: "sh" }), true);
  assert.equal(binPresent(XDG_TERMINAL_BIN, { TERMINAL: "mission-no-such-terminal" }), false);
});

test("on macOS it is never present, whatever $TERMINAL says", { skip: process.platform !== "darwin" }, () => {
  assert.equal(binPresent(XDG_TERMINAL_BIN, { TERMINAL: "sh" }), false);
});

/** Every registered backend as a fake, with the real default-terminal adapter over fake launchers. */
function targets(platform: NodeJS.Platform, over: Partial<TerminalTargetDeps> = {}) {
  const { emulator, started } = recording([XDG], {});
  const opened: string[] = [];
  const recordingEmu = (id: "wezterm" | "ghostty" | "iterm", label: string) =>
    fakeEmulator({
      id,
      label,
      spawn: {
        tab: async () => {
          opened.push(id);
          return { ...OK, target: null };
        },
      },
    });
  const deps: TerminalTargetDeps = {
    multiplexers: {
      tmux: fakeMultiplexer({
        sessions: {
          spawnDetached: async (spec) => ({ ...OK, session: spec.name }),
          attachArgv: (name) => ["/usr/bin/tmux", "attach", "-t", name],
          rename: async () => OK,
          kill: async () => OK,
          alive: null,
          closeIfOnlyPane: null,
          names: PLAIN_NAMES,
        },
      }),
    },
    emulators: {
      wezterm: recordingEmu("wezterm", "WezTerm"),
      ghostty: recordingEmu("ghostty", "Ghostty"),
      iterm: recordingEmu("iterm", "iTerm2"),
      "xdg-terminal": emulator,
    },
    // Only tmux and the default terminal are on this machine.
    installed: (spec) => spec === MUX_BIN || spec === XDG_TERMINAL_BIN,
    unsupported: (spec) => binUnsupportedReason(spec, platform),
    launchId: () => "abc123",
    focusEmulator: () => null,
    ...over,
  };
  return { deps, started, opened };
}

test("on Linux with no WezTerm or Ghostty, tmux is raised in the default terminal", async () => {
  const { deps, started, opened } = targets("linux");
  const views = terminalTargetViews(deps);
  assert.equal(views.at(-1)?.id, "xdg-terminal");
  assert.equal(views.find((v) => v.id === "xdg-terminal")?.unavailable, null);
  assert.equal(views.find((v) => v.id === "tmux")?.blurb, "New session, raised in Default terminal.");

  const result = await launchTerminal("tmux", { name: "api", cwd: "/w/api", argv: ["zsh"] }, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(opened, []);
  assert.deepEqual(started.map((s) => s.argv), [["/usr/bin/xdg-terminal-exec", "/usr/bin/tmux", "attach", "-t", "api-abc123"]]);
});

test("it comes after Ghostty in the attempt order, and the preference still wins", async () => {
  assert.deepEqual(emulatorAttemptOrder("tmux", { focusEmulator: () => null }), [
    "wezterm",
    "ghostty",
    "iterm",
    "xdg-terminal",
  ]);

  // Everything installed: Automatic takes WezTerm, never the fallback.
  const automatic = targets("linux", { installed: () => true });
  await launchTerminal("tmux", { name: "api", cwd: "/w/api", argv: ["zsh"] }, automatic.deps);
  assert.deepEqual(automatic.opened, ["wezterm"]);
  assert.equal(automatic.started.length, 0);

  // Ghostty is there and installed; the stored choice of the default terminal is still obeyed.
  const preferred = targets("linux", { installed: () => true, focusEmulator: () => "xdg-terminal" });
  assert.deepEqual(emulatorAttemptOrder("tmux", preferred.deps)[0], "xdg-terminal");
  await launchTerminal("tmux", { name: "api", cwd: "/w/api", argv: ["zsh"] }, preferred.deps);
  assert.deepEqual(preferred.opened, []);
  assert.equal(preferred.started.length, 1);
});

test("on macOS it has no row anywhere and is never tried", async () => {
  const { deps, started } = targets("darwin", { installed: () => true });
  const views = terminalTargetViews(deps);
  assert.equal(views.some((v) => v.id === "xdg-terminal"), false);
  assert.deepEqual(views.map((v) => v.id), ["tmux", "wezterm", "ghostty", "iterm"]);

  // Even preferred, an unsupported terminal is skipped rather than launched.
  const preferred = targets("darwin", { installed: () => true, focusEmulator: () => "xdg-terminal" });
  await launchTerminal("tmux", { name: "api", cwd: "/w/api", argv: ["zsh"] }, preferred.deps);
  assert.equal(started.length + preferred.started.length, 0);
  assert.equal((await launchTerminal("xdg-terminal", { name: "x", cwd: "/w", argv: ["zsh"] }, deps)).status, 404);
});

test("the detached launch reports a refusal, a missing command, and an open window", async () => {
  const sh: XdgTerminalLauncher = { name: "sh", path: FIXED_OS_EXECUTABLES.sh, env: {}, prefix: ["-c"] };
  assert.deepEqual(await launchDetached(sh, ["exit 3"], { cwd: null, settleMs: 5_000 }), {
    ok: false,
    error: "sh exited with status 3",
    outcomeUnknown: false,
  });
  // A launcher that hands the window to a running server exits 0 straight away.
  assert.deepEqual(await launchDetached(sh, ["exit 0"], { cwd: null, settleMs: 5_000 }), {
    ok: true,
    outcomeUnknown: false,
  });
  // Killed rather than answering: the window may be open, so this must stay unknown - the
  // adapter neither tries `$TERMINAL` after it nor lets the launcher tear the session down.
  assert.deepEqual(await launchDetached(sh, ["kill -TERM $$"], { cwd: null, settleMs: 5_000 }), {
    ok: false,
    error: "sh was killed by SIGTERM",
    outcomeUnknown: true,
  });
  // Still running when the settle window closes: the terminal is showing its window.
  assert.deepEqual(await launchDetached(sh, ["sleep 2"], { cwd: null, settleMs: 50 }), {
    ok: true,
    outcomeUnknown: false,
  });
  const missing = await launchDetached(
    { ...sh, name: "ghost", path: join(tmpdir(), "mission-test-no-such-terminal") },
    [],
    { cwd: null, settleMs: 5_000 },
  );
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /^ghost: .*ENOENT/);
});

test("it never hosts a dispatched agent: dispatch skips it and its chooser row says why", async () => {
  // Only the default terminal can open a window here, and it is installed and supported.
  const { deps, started } = targets("linux", {
    installed: (spec) => spec === XDG_TERMINAL_BIN,
  });
  const home: HomeDeps = {
    multiplexers: {
      tmux: deps.multiplexers.tmux!,
      herdr: fakeMultiplexer({ id: "herdr" }),
      cmux: fakeMultiplexer({ id: "cmux" }),
    },
    emulators: {
      wezterm: deps.emulators.wezterm!,
      ghostty: deps.emulators.ghostty!,
      iterm: deps.emulators.iterm!,
      "xdg-terminal": deps.emulators["xdg-terminal"]!,
    },
    installed: deps.installed,
    unsupported: deps.unsupported,
    focusEmulator: deps.focusEmulator,
  };
  assert.equal(EMULATORS["xdg-terminal"].raiseOnly, true);
  assert.deepEqual(homeBackends(home), []);
  assert.deepEqual(homeBackends(home, "xdg-terminal"), []);

  const spec = { name: "api", cwd: "/w/api", argv: ["claude"], sidePane: false };
  const automatic = await launchHome(spec, home);
  assert.equal(automatic.ok, false);
  // The install hint names only backends that could host the agent.
  assert.equal(
    automatic.ok ? null : automatic.error,
    "no terminal backend can host a dispatched agent - install one of tmux, herdr, cmux, wezterm, ghostty, iterm",
  );
  const preferred = await launchHome(spec, home, "xdg-terminal");
  assert.equal(
    preferred.ok ? null : preferred.error,
    "the selected terminal backend xdg-terminal cannot host a dispatched agent on this machine",
  );
  assert.equal(started.length, 0, "no window was opened for a dispatch");

  // Still offered to Focus: the window-opening row is available, the dispatch row is not.
  const row = terminalTargetViews(deps).find((view) => view.id === "xdg-terminal");
  assert.equal(row?.unavailable, null);
  assert.equal(
    row?.dispatchUnavailable,
    "Default terminal only shows multiplexer sessions - it cannot host an agent",
  );
});

test("only a raise-only terminal refuses to host an agent, before anything is launched", async () => {
  // The Linux Ghostty is spawn-only too, so on a Linux host it refuses for the same reason.
  const raiseOnly: Partial<Record<string, string>> = {
    "xdg-terminal": "Default terminal only shows multiplexer sessions - it cannot host an agent",
    ...(process.platform === "linux"
      ? { ghostty: "Ghostty only shows multiplexer sessions - it cannot host an agent" }
      : {}),
  };
  for (const id of TERMINAL_BACKEND_IDS) {
    assert.equal(agentHostUnavailable(id), raiseOnly[id] ?? null, id);
  }
  let calls = 0;
  const refused = await launchAgentTerminal(
    "xdg-terminal",
    { name: "api", cwd: "/w/api", argv: ["claude"] },
    async () => {
      calls += 1;
      return { ok: true, label: "Default terminal", status: 200 };
    },
  );
  assert.deepEqual(
    { ok: refused.ok, status: refused.status, error: refused.error },
    { ok: false, status: 409, error: "Default terminal only shows multiplexer sessions - it cannot host an agent" },
  );
  assert.equal(calls, 0);
});
