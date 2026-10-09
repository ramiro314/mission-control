#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How each platform's OS lists the idle-system-sleep assertions it holds. `held` answers
 * whether the listing shows an assertion with this exact reason of the idle-system-sleep kind,
 * and nothing broader.
 */
const OBSERVERS = {
  darwin: {
    command: "/usr/bin/pmset",
    args: ["-g", "assertions"],
    held: (listing, reason) =>
      listing.includes(reason) && listing.includes("PreventUserIdleSystemSleep"),
  },
  // `powercfg /requests` prints one block per request type, and a power request lists its
  // reason under its caller. It is the only listing that names a request's reason, and it runs
  // only in an elevated shell: GitHub's Windows runners are one, a developer's terminal usually
  // is not.
  win32: {
    command: "powercfg",
    args: ["/requests"],
    held: (listing, reason) => (powercfgSections(listing).get("SYSTEM") ?? "").includes(reason),
    refused:
      "powercfg /requests lists power requests only in an elevated shell. Run " +
      "`npm run verify:keep-awake-native` from a terminal opened with Run as administrator.",
  },
};

/** Split `powercfg /requests` output into its `TYPE:` blocks. */
export function powercfgSections(listing) {
  const sections = new Map();
  let current = null;
  for (const line of listing.split(/\r?\n/)) {
    const heading = /^([A-Z]+):\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections.set(current, "");
    } else if (current !== null) {
      sections.set(current, `${sections.get(current)}${line}\n`);
    }
  }
  return sections;
}

/**
 * The observer's listing. When the OS refuses it, the error carries what the OS printed and,
 * where the observer knows the usual cause, what to do about it.
 */
export function listAssertions(observer, run = execFileSync) {
  try {
    return run(observer.command, observer.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const said = String(err?.stderr ?? "").trim() || String(err?.message ?? err);
    const hint = observer.refused ? `\n${observer.refused}` : "";
    throw new Error(`${observer.command} ${observer.args.join(" ")} failed: ${said}${hint}`);
  }
}

export function keepAwakeObserver(platform) {
  if (!Object.hasOwn(OBSERVERS, platform)) {
    throw new Error(`native Keep Awake verification requires macOS or Windows, not ${platform}`);
  }
  return OBSERVERS[platform];
}

function main() {
  const observer = keepAwakeObserver(process.platform);
  const list = () => listAssertions(observer);
  const binding = createRequire(import.meta.url)(resolve("dist/native/keep-awake.node"));
  const reason = `Mission Control native Keep Awake verification ${process.pid}`;
  let handle;
  try {
    handle = binding.create(reason);
    if (!observer.held(list(), reason)) {
      throw new Error(`${observer.command} did not report the native idle-system-sleep assertion`);
    }
    console.log(`[keep-awake-native] assertion observed for pid ${process.pid}`);
  } finally {
    if (handle !== undefined) binding.release(handle);
  }

  if (list().includes(reason)) {
    throw new Error("native Keep Awake assertion remained after release");
  }
  console.log("[keep-awake-native] assertion released");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
