// A stateful GitHub CLI boundary. It knows only argv, never Mission Control's policy.
// Omitting -F draft=true creates a ready PR; view reads the saved creation state separately.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = process.env.DRAFT_PR_FIXTURE_STORE;
assert.ok(path, "an isolated PR store is required");
const prs = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
const args = process.argv.slice(2);
// Fork: PRs open through the REST create (`gh api repos/<o>/<r>/pulls ... --jq .html_url`), whose
// draft flag is `-F draft=true`, never `gh pr create`.
const restCreate = args[0] === "api" && /^repos\/[^/]+\/[^/]+\/pulls$/.test(args[1] ?? "");
assert.ok(restCreate || args[0] === "pr");
if (restCreate) {
  const number = prs.length + 1;
  const pr = { number, url: `https://github.example.test/fixture/repo/pull/${number}`,
    isDraft: args.some((arg, i) => arg === "draft=true" && args[i - 1] === "-F"), state: "OPEN" };
  prs.push(pr);
  writeFileSync(path, JSON.stringify(prs));
  console.log(pr.url);
} else if (args[1] === "view") {
  const pr = prs.find((item) => item.url === args[2]);
  assert.ok(pr, "view cannot succeed before creation");
  console.log(JSON.stringify(pr));
} else {
  throw new Error(`Unexpected GitHub write or command: ${args.join(" ")}`);
}
