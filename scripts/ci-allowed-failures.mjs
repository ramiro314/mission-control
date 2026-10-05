#!/usr/bin/env node

// Lists the steps of a Windows CI job that failed while they were allowed to fail, as warning
// annotations and in the job summary. A step that continues on error leaves its job green, so
// without this the failure would be visible only inside the step log. See the "Windows" section
// of `.github/workflows/ci.yml`.
//
// Input, through env: STEPS_JSON, the job's `toJSON(steps)`. A step failed while allowed to
// when its outcome is `failure` but its conclusion is `success`. Always exits 0: whether a
// failure fails the job is the step's own `continue-on-error`, not this report's decision.

import { appendFileSync } from "node:fs";

const steps = JSON.parse(process.env.STEPS_JSON || "{}");
const failed = Object.entries(steps)
  .filter(([, step]) => step?.outcome === "failure" && step?.conclusion === "success")
  .map(([id]) => id);

const summary = failed.length === 0
  ? ["No step failed while allowed to fail."]
  : [
    "These steps failed. The Windows jobs are allowed to fail until M2 is green",
    "(docs/plans/windows-support/plan.md, M2 item 12):",
    "",
    ...failed.map((id) => `- \`${id}\``),
  ];

for (const id of failed) {
  console.log(`::warning title=Windows CI (allowed to fail)::step '${id}' failed`);
}
console.log(summary.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
}
