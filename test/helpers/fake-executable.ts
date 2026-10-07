import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one way a unit test or e2e fixture writes a fake CLI (`gh`, `claude`, `jira`, `git`,
 * `node`, `conduct-ts`, ...) for the product to run in place of the real one.
 *
 * A fake is a Node.js script. On macOS and Linux it is written executable under a
 * `#!/usr/bin/env node` shebang, as fixtures always wrote it, and the returned path is the
 * script itself.
 *
 * Windows starts nothing by its shebang: spawning the script fails with `EFTYPE`, and Node
 * refuses to spawn a `.cmd` shim without a shell, which the product never asks for. A real
 * Windows tool is an `.exe` (`claude.exe`, `gh.exe`, `git.exe`), so on win32 the script is
 * joined by `<script>.exe`, a small launcher compiled once from
 * `fake-executable-launcher.cs`, and `<script>.launch`, which names this Node and the script.
 * The returned path is the `.exe`. The product resolves and spawns it exactly as it would a
 * Windows user's own tool: a `*_BIN` override names it directly, and a fake found through PATH
 * needs nothing more, because the win32 ladder looks a bare `gh` up as `gh.exe`.
 *
 * Point `*_BIN` overrides at the RETURNED path, never at the script path you passed in: on
 * win32 the script is not something the product can start.
 */

const NODE_SHEBANG = "#!/usr/bin/env node";
const LAUNCHER_SOURCE = fileURLToPath(new URL("./fake-executable-launcher.cs", import.meta.url));

/** The path the product starts the fake at `path` by: `<path>.exe` on win32, `path` elsewhere. */
export function fakeExecutablePath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${path}.exe` : path;
}

/**
 * Write `script`, a Node.js program, as a fake executable at `path`, and return the path to
 * start it by. A leading `#!/usr/bin/env node` is optional; any other shebang is refused,
 * because only a Node.js script starts on every platform this suite runs on.
 */
export function writeFakeExecutable(path: string, script: string): string {
  const absolute = resolve(path);
  const invoked = fakeExecutablePath(absolute);
  publish(absolute, nodeScript(script));
  if (invoked !== absolute) {
    // The launcher is the same program for every fake, so one already in place (and perhaps
    // running, which Windows will not let anything replace) is left alone.
    if (!existsSync(invoked)) copyFileSync(win32Launcher(), invoked);
    publish(`${absolute}.launch`, `${process.execPath}\n${absolute}\n`);
  }
  return invoked;
}

/**
 * Replace the file at `path` by rename rather than by writing it in place: Linux refuses a
 * write to a script an earlier run still executes (`ETXTBSY`), and a rename leaves that run
 * its old copy.
 */
function publish(path: string, contents: string): void {
  const next = `${path}.${process.pid}.next`;
  writeFileSync(next, contents);
  chmodSync(next, 0o755);
  renameSync(next, path);
}

/** Install a second copy of the fake `fake` (a path `writeFakeExecutable` returned) at `path`. */
export function copyFakeExecutable(fake: string, path: string): string {
  const script = process.platform === "win32" ? fake.replace(/\.exe$/i, "") : fake;
  return writeFakeExecutable(path, readFileSync(script, "utf8"));
}

/** Remove the fake written at `path`, including its win32 launcher, so nothing can find it. */
export function removeFakeExecutable(path: string): void {
  for (const file of [path, fakeExecutablePath(path), `${path}.launch`]) rmSync(file, { force: true });
}

function nodeScript(script: string): string {
  if (!script.startsWith("#!")) return `${NODE_SHEBANG}\n${script}`;
  if (script.startsWith(`${NODE_SHEBANG}\n`)) return script;
  throw new Error(
    `a fake executable must be a Node.js script so it starts on win32 too; got ${script.split("\n", 1)[0]}`,
  );
}

let launcher: string | null = null;

/**
 * The compiled launcher, built on first use and kept in the temp dir under its source's hash,
 * so concurrent test workers share one build and an edited source builds a new one.
 */
function win32Launcher(): string {
  if (launcher) return launcher;
  const source = readFileSync(LAUNCHER_SOURCE);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "mission-fake-executable-launcher");
  const built = join(dir, `launcher-${hash}.exe`);
  if (!existsSync(built)) {
    mkdirSync(dir, { recursive: true });
    const staging = mkdtempSync(join(dir, "build-"));
    try {
      const output = join(staging, "launcher.exe");
      execFileSync(cscPath(), ["/nologo", "/target:exe", "/optimize+", `/out:${output}`, LAUNCHER_SOURCE], {
        stdio: "pipe",
      });
      // Published by rename, so a worker never copies a half-written launcher. Losing the race
      // to another worker that published the same source first is fine.
      try {
        renameSync(output, built);
      } catch (error) {
        if (!existsSync(built)) throw error;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  launcher = built;
  return built;
}

/** The C# compiler the .NET Framework installs with every Windows 10 and 11 system. */
function cscPath(): string {
  const windows = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  for (const framework of ["Framework64", "Framework"]) {
    const csc = join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    if (existsSync(csc)) return csc;
  }
  throw new Error(`no .NET Framework C# compiler under ${windows}\\Microsoft.NET to build the fake executable launcher`);
}
