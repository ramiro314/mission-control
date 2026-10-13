import assert from "node:assert/strict";
import test from "node:test";
import { WindowStartup, type StartupScreen } from "../src/main/window-startup.ts";
import { startupPage } from "../src/main/startup-page.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(show?: (screen: StartupScreen, signal: AbortSignal) => Promise<void>) {
  let now = 0;
  let ready = false;
  let resume: (() => void) | undefined;
  let loads = 0;
  let loaded = 0;
  let rejectLoad = false;
  let notice: StartupScreen | null = null;
  const screens: StartupScreen[] = [];
  const errors: unknown[] = [];
  const startup = new WindowStartup({
    now: () => now,
    show: async (screen, signal) => { screens.push(screen); await show?.(screen, signal); },
    ready: async () => ready,
    load: async () => { loads++; if (rejectLoad) throw new Error("connection lost after health"); },
    loaded: () => { loaded++; },
    log: (error) => { errors.push(error); },
    notice: () => notice,
    clearNotice: () => { notice = null; },
    pause: (signal) => new Promise<void>((resolve) => {
      const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
      resume = finish;
      signal.addEventListener("abort", finish, { once: true });
    }),
  });
  return {
    startup, screens, errors,
    ready: (value: boolean) => { ready = value; },
    failLoad: (value: boolean) => { rejectLoad = value; },
    notice: (value: StartupScreen) => { notice = value; },
    currentNotice: () => notice,
    loads: () => loads,
    loaded: () => loaded,
    async tick(time: number) { now = time; resume?.(); await flush(); },
  };
}

test("startup waits for readiness, reports a delay at 60 seconds, then recovers automatically", async () => {
  const f = fixture();
  const done = f.startup.start();
  await flush();
  assert.deepEqual(f.screens, ["starting"]);
  await f.tick(20_000);
  assert.equal(f.loads(), 0, "crossing the former retry budget cannot load an unavailable origin");
  await f.tick(59_999);
  assert.deepEqual(f.screens, ["starting"]);
  await f.tick(60_000);
  assert.deepEqual(f.screens, ["starting", "slow"]);
  await f.tick(120_000);
  assert.equal(f.loads(), 0);
  assert.deepEqual(f.screens, ["starting", "slow"], "polling preserves the retry control and focus");
  f.ready(true);
  await f.tick(121_000);
  await done;
  assert.equal(f.loaded(), 1);
  await f.startup.start();
  assert.equal(f.loads(), 1, "a completed startup cannot reload active work");
});

test("a notice from the background start replaces the wait at once, survives Retry, and still loads when ready", async () => {
  const f = fixture();
  const first = f.startup.start();
  await flush();
  await f.tick(30_000);
  assert.deepEqual(f.screens, ["starting"]);
  f.notice("service");
  await f.tick(31_000);
  assert.deepEqual(f.screens, ["starting", "service"]);
  await f.tick(90_000);
  assert.deepEqual(f.screens, ["starting", "service"], "the notice is not replaced by the generic delay");
  const second = f.startup.start();
  await flush();
  await first;
  assert.deepEqual(f.screens, ["starting", "service", "starting", "service"]);
  f.ready(true);
  await f.tick(91_000);
  await second;
  assert.equal(f.loaded(), 1);
  assert.equal(f.currentNotice(), null, "a loaded dashboard ends the wait the notice explained");
});

test("a window opened after the dashboard loaded never shows the earlier run's notice during a brief outage", async () => {
  // One notice for the process, as window.ts keeps it, shared by the first window and a later one.
  let notice: StartupScreen | null = null;
  let ready = false;
  let resume: (() => void) | undefined;
  const startup = (screens: StartupScreen[]) => new WindowStartup({
    now: () => 0,
    show: async (screen) => { screens.push(screen); },
    ready: async () => ready,
    load: async () => {},
    loaded: () => {},
    log: assert.fail,
    notice: () => notice,
    clearNotice: () => { notice = null; },
    pause: (signal) => new Promise<void>((resolve) => {
      resume = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  });

  const first: StartupScreen[] = [];
  const firstRun = startup(first).start();
  await flush();
  notice = "service";
  resume?.();
  await flush();
  assert.deepEqual(first, ["starting", "service"]);
  ready = true;
  resume?.();
  await firstRun;

  // The unit restarts: the daemon is unreachable for a moment when the window is recreated.
  ready = false;
  const second: StartupScreen[] = [];
  const later = startup(second);
  const secondRun = later.start();
  await flush();
  resume?.();
  await flush();
  assert.deepEqual(second, ["starting"], "no claim of a 30 s silence nobody waited through");
  later.stop();
  await secondRun;
});

test("the service screen names the unit's journal and offers Retry", () => {
  const page = startupPage("service", "linux");
  assert.match(page, /<h1>The Mission Control service is not answering<\/h1>/);
  assert.match(page, /<code>journalctl --user -u mission-control<\/code>/);
  assert.match(page, /Retry now/);
});

test("a healthy startup loads immediately without waiting for the timeout", async () => {
  const f = fixture();
  f.ready(true);
  await f.startup.start();
  assert.equal(f.loads(), 1);
  assert.equal(f.loaded(), 1);
  assert.deepEqual(f.screens, ["starting"]);
});

for (const screen of ["starting", "slow", "error"] as const) {
  test(`a failed ${screen} page retries without abandoning startup`, async () => {
    let failed = false;
    const f = fixture(async (state) => {
      if (state === screen && !failed) { failed = true; throw new Error("local navigation failed"); }
    });
    f.ready(screen === "error");
    f.failLoad(screen === "error");
    const done = f.startup.start();
    await flush();
    if (screen === "slow") await f.tick(60_000);
    assert.equal(failed, true);
    f.failLoad(false);
    f.ready(true);
    await f.tick(61_000);
    await f.tick(62_000);
    assert.equal(f.screens.filter((state) => state === screen).length, 2);
    assert.equal(f.loaded(), 1);
    await done;
  });

  for (const action of ["stop", "Retry"] as const) {
    test(`${action} cancels an in-flight ${screen} page`, async () => {
      let pendingSignal: AbortSignal | undefined;
      let cancelled = false;
      const f = fixture(async (state, signal) => {
        if (state !== screen || pendingSignal) return;
        pendingSignal = signal;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => {
          cancelled = true;
          resolve();
        }, { once: true }));
      });
      const first = f.startup.start();
      f.ready(screen === "error");
      f.failLoad(screen === "error");
      await flush();
      if (screen === "slow") await f.tick(60_000);
      assert.ok(pendingSignal, "local navigation must receive its attempt signal");
      f.ready(true);
      f.failLoad(false);
      if (action === "stop") f.startup.stop();
      else await f.startup.start();
      assert.equal(pendingSignal.aborted, true);
      assert.equal(cancelled, true);
      await first;
      assert.equal(f.loaded(), action === "stop" ? 0 : 1);
    });
  }
}

test("Retry cancels the old attempt and resets the delay message", async () => {
  const f = fixture();
  const first = f.startup.start();
  await flush();
  await f.tick(60_000);
  const second = f.startup.start();
  await flush();
  await first;
  assert.deepEqual(f.screens, ["starting", "slow", "starting"]);
  f.ready(true);
  await f.tick(60_001);
  await second;
  assert.equal(f.loads(), 1);
  assert.equal(f.loaded(), 1);
});

test("a navigation failure after successful health returns to a visible retry screen", async () => {
  const f = fixture();
  f.ready(true);
  f.failLoad(true);
  const done = f.startup.start();
  await flush();
  assert.deepEqual(f.screens, ["starting", "error"]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.loaded(), 0);
  f.failLoad(false);
  await f.tick(1000);
  await done;
  assert.equal(f.loads(), 2);
  assert.equal(f.loaded(), 1);
});

for (const boundary of ["health", "navigation"] as const) {
  test(`closing the window during ${boundary} prevents stale startup work`, async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let signal!: AbortSignal;
    let loads = 0;
    let loaded = 0;
    const startup = new WindowStartup({
      now: Date.now, show: async () => {},
      ready: async (s) => { signal = s; if (boundary === "health") await pending; return true; },
      load: async (s) => { signal = s; loads++; await pending; },
      loaded: () => { loaded++; }, log: assert.fail,
      pause: async () => { assert.fail("closed startup must not schedule another attempt"); },
    });
    const done = startup.start();
    await flush();
    startup.stop();
    assert.equal(signal.aborted, true);
    release();
    await done;
    await startup.start();
    assert.equal(loads, boundary === "health" ? 0 : 1);
    assert.equal(loaded, 0);
  });
}
