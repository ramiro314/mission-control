import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/gen-icons.mjs", import.meta.url));

function hasRsvg(): boolean {
  try {
    execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): [number, number] {
  const bytes = readFileSync(path);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("renders every PNG from the SVG sources, and off macOS skips iconutil cleanly", { skip: !hasRsvg() && "rsvg-convert is not installed" }, (t) => {
  const out = mkdtempSync(join(tmpdir(), "gen-icons-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const run = spawnSync(process.execPath, [script, out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);

  const sizes: Record<string, number> = {
    "icon.png": 512,
    "trayTemplate.png": 16,
    "trayTemplate@2x.png": 32,
    "tray-light.png": 32,
    "tray-light@2x.png": 64,
    "tray-badged.png": 32,
    "tray-badged@2x.png": 64,
  };
  for (const [name, size] of Object.entries(sizes)) {
    assert.deepEqual(pngSize(join(out, name)), [size, size], name);
  }

  const expected = Object.keys(sizes);
  if (process.platform === "darwin") expected.push("icon.icns");
  else assert.match(run.stdout, /skipped icon\.icns: iconutil ships only with macOS/);
  // No iconset, finished or partial, is left behind.
  assert.deepEqual(readdirSync(out).sort(), expected.sort());
});
