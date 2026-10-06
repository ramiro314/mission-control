/**
 * Every `tsx watch` lane that `concurrently` starts reads its stdin from /dev/null.
 *
 * `tsx watch` reads its own stdin so Return can rerun the child, and the child inherits that
 * same handle. Under `concurrently` the handle is an idle pipe. On win32, a child that touches
 * `process.stdin` blocks while the watcher's read on that pipe is pending, and the daemon
 * touches it before it serves anything: `@hono/node-server/serve-static` does
 * `import { versions } from "process"`, and building that namespace reads the lazy `stdin`
 * getter. `make start` then sat silent with no listening socket.
 *
 * `concurrently` never forwards input here (no `--handle-input`), so the Return rerun could
 * not fire in a lane on any platform, and /dev/null changes nothing on macOS or Linux. Plain
 * `npm run dev:server` keeps its terminal, so the Return rerun still works there.
 *
 * Each lane is its own npm script, because `concurrently` runs a command through cmd.exe on
 * win32 while npm runs a script through its script-shell, which is Git Bash on Windows. The
 * lane `exec`s the watcher rather than nesting `npm run`: Git Bash forks to apply a redirect
 * to a child, and the fork's exit orphans the watcher from the Windows process tree, so the
 * tree kill that stops `make start` would leave the daemon holding its port.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

/**
 * Whether running `name` reaches a `tsx watch`. With `honorDetached`, a `< /dev/null` on the
 * way stops the walk, so the answer is whether that watch still reads the stdin it was given.
 */
function reachesTsxWatch(name: string, honorDetached: boolean, seen = new Set<string>()): boolean {
  const script = pkg.scripts[name];
  if (script === undefined || seen.has(name)) return false;
  seen.add(name);
  if (honorDetached && /<\s*\/dev\/null/.test(script)) return false;
  if (/\btsx watch\b/.test(script)) return true;
  return [...script.matchAll(/\bnpm run ([\w:-]+)/g)].some((match) => reachesTsxWatch(match[1]!, honorDetached, seen));
}

test("tsx watch lanes under concurrently read stdin from /dev/null", () => {
  let watchLanes = 0;
  for (const name of ["dev", "dev:desktop", "dev:start"]) {
    const script = pkg.scripts[name] ?? "";
    assert.match(script, /^concurrently /, `${name} no longer runs concurrently`);
    for (const [, lane] of script.matchAll(/"npm:([\w:-]+)"/g)) {
      if (!reachesTsxWatch(lane!, false)) continue;
      watchLanes++;
      assert.equal(reachesTsxWatch(lane!, true), false, `${name} runs ${lane} with its stdin attached`);
    }
  }
  // dev, dev:desktop and dev:start each run the daemon, and dev:start also runs the Foreman.
  assert.equal(watchLanes, 4);
});

test("each lane is its terminal script with the watcher exec'd onto /dev/null", () => {
  for (const base of ["dev:server", "dev:foreman"]) {
    const script = pkg.scripts[base] ?? "";
    assert.match(script, /\btsx watch [^&|;<]+$/, `${base} no longer ends in a tsx watch`);
    assert.equal(pkg.scripts[`${base}:lane`], `${script.replace(/\btsx watch\b/, "exec tsx watch")} < /dev/null`);
  }
});

test("the walk sees a tsx watch that keeps its stdin", () => {
  assert.equal(reachesTsxWatch("dev:server", true), true);
  assert.equal(reachesTsxWatch("dev:foreman", true), true);
  assert.equal(reachesTsxWatch("dev:server:lane", true), false);
});
