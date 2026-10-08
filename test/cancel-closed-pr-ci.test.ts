import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflows = join(import.meta.dirname, "..", ".github", "workflows");
const read = (name: string) => readFileSync(join(workflows, name), "utf8");

// The cancel workflow only works while its concurrency group is the exact string `ci.yml`
// evaluates for a pull request run; a renamed workflow or regrouped CI would silently stop it.
test("closing a pull request joins its CI run's concurrency group", () => {
  const ci = read("ci.yml");
  const cancel = read("cancel-closed-pr-ci.yml");

  assert.match(ci, /^name: CI$/m);
  assert.match(ci, /^concurrency:\n {2}group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true$/m);
  assert.match(cancel, /^ {4}types: \[closed\]$/m);
  assert.match(
    cancel,
    /^concurrency:\n {2}group: ci-CI-refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/merge\n {2}cancel-in-progress: true$/m,
  );
});
