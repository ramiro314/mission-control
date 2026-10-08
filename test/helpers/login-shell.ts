import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { windowsPowerShellPath } from "../../src/server/platform/executable-environment.ts";
import { writeFakeExecutable } from "./fake-executable.ts";

/**
 * Write `script`, a Node.js program, as the fake the product reads the login environment's
 * PATH through, and return the environment entries that point the product at it.
 *
 * Each platform has its own PATH read (`src/server/platform/executable-environment.ts`):
 *
 * - **POSIX** starts `$SHELL -ilc ...`, so the fake is `<root>/login-shell` under a shebang
 *   naming this Node by its absolute path, because a fixture's PATH need not carry `node`.
 *   The entry returned is `SHELL`.
 * - **win32** first queries the registry with `reg.exe` under `%SystemRoot%`, and falls back to
 *   Windows PowerShell by its fixed path under the same root. The fake is that `powershell.exe`
 *   under `<root>/Windows`, written through `writeFakeExecutable`; the fake root has no
 *   `reg.exe`, so every read reaches it. The entry returned is `SystemRoot`.
 *
 * Either way the script ignores the arguments the product passes and writes whatever the
 * test wants the probe to read, between `__MISSION_PATH__` markers.
 */
export function writeFakeLoginShell(
  root: string,
  script: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (platform === "win32") {
    const systemRoot = join(root, "Windows");
    const powershell = windowsPowerShellPath({ SystemRoot: systemRoot });
    mkdirSync(dirname(powershell), { recursive: true });
    writeFakeExecutable(powershell.replace(/\.exe$/i, ""), script);
    return { SystemRoot: systemRoot };
  }
  const shell = join(root, "login-shell");
  writeFileSync(shell, `#!${process.execPath}\n${script}`);
  chmodSync(shell, 0o755);
  return { SHELL: shell };
}
