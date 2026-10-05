import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/ci-allowed-failures.mjs", import.meta.url));

function report(steps: Record<string, { outcome: string; conclusion: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "ci-allowed-failures-"));
  const summaryFile = join(dir, "summary.md");
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, STEPS_JSON: JSON.stringify(steps), GITHUB_STEP_SUMMARY: summaryFile },
      encoding: "utf8",
    });
    return { stdout, summary: readFileSync(summaryFile, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("warns about each step that failed while allowed to, and only those", () => {
  const { stdout, summary } = report({
    build: { outcome: "success", conclusion: "success" },
    test: { outcome: "failure", conclusion: "success" },
    smoke: { outcome: "skipped", conclusion: "skipped" },
    keep_awake: { outcome: "failure", conclusion: "success" },
    strict: { outcome: "failure", conclusion: "failure" },
  });
  const warnings = stdout.split("\n").filter((line) => line.startsWith("::warning"));
  assert.deepEqual(warnings, [
    "::warning title=Windows CI (allowed to fail)::step 'test' failed",
    "::warning title=Windows CI (allowed to fail)::step 'keep_awake' failed",
  ]);
  assert.match(summary, /- `test`\n- `keep_awake`\n$/);
  assert.doesNotMatch(summary, /strict|build|smoke/);
});

test("says so when nothing failed", () => {
  const { stdout, summary } = report({ typecheck: { outcome: "success", conclusion: "success" } });
  assert.doesNotMatch(stdout, /::warning/);
  assert.equal(summary, "No step failed while allowed to fail.\n");
});
