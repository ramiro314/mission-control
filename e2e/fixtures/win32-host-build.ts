import { build } from "esbuild";
import { join } from "node:path";

/**
 * Build the production daemon entry with only its host-platform answer replaced by win32
 * (`src/server/platform/host.ts`), so a spec drives the win32 harness refusals through a
 * browser on any runner. Everything else, including process handling, stays this host's.
 */
export async function buildWin32HostDaemon(root: string, id: string): Promise<string> {
  // Same depth as index.mjs: runtime assets resolve relative to the daemon bundle.
  const outfile = join(root, "dist/server", `e2e-win32-host-${id}.mjs`);
  await build({
    absWorkingDir: root, entryPoints: ["src/server/index.ts"], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22",
    mainFields: ["module", "main"], alias: { "@shared": "./src/shared" },
    banner: { js: "import{createRequire as __mcCreateRequire}from'node:module';const require=__mcCreateRequire(import.meta.url);" },
    plugins: [{ name: "win32-host", setup(plugin) {
      plugin.onLoad({ filter: /src[\\/]server[\\/]platform[\\/]host\.ts$/ }, () => ({
        loader: "ts",
        contents: "export function hostPlatform(): NodeJS.Platform { return \"win32\"; }\n",
      }));
    } }],
  });
  return outfile;
}
