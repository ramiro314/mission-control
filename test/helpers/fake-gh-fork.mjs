// A fake `gh` for test/fork-migrate.test.ts. It keeps a repository's labels, issues and PRs in
// the JSON file named by FAKE_GH_STATE, answers the commands scripts/fork-migrate.mjs runs, and
// records every call so a test can count the writes. It never reaches GitHub.

import { readFileSync, writeFileSync } from "node:fs";

const path = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
const input = args.includes("-") ? readFileSync(0, "utf8") : "";
state.calls.push(args);

function option(name) {
  const values = [];
  args.forEach((arg, i) => arg === name && values.push(args[i + 1]));
  return values;
}

const issueOf = (n) => state.issues.find((i) => i.number === Number(n));
const named = (labels) => labels.map((name) => ({ name }));
let out = "";

switch (`${args[0]} ${args[1]}`) {
  case "label list":
    out = JSON.stringify(named(state.labels));
    break;
  case "label create":
    state.labels.push(args[2]);
    break;
  case "issue list":
    out = JSON.stringify(
      state.issues
        .filter((i) => i.labels.includes(option("--label")[0]))
        .map((i) => ({ ...i, labels: named(i.labels), comments: i.comments.map((body) => ({ body })) })),
    );
    break;
  case "issue create": {
    const number = 1000 + state.issues.length;
    state.issues.push({ number, title: option("--title")[0], state: "OPEN", labels: option("--label"), body: input, comments: [] });
    out = `https://github.com/ramiro314/mission-control/issues/${number}\n`;
    break;
  }
  case "issue edit": {
    const issue = issueOf(args[2]);
    if (option("--title").length) issue.title = option("--title")[0];
    if (option("--body-file").length) issue.body = input;
    const remove = (option("--remove-label")[0] ?? "").split(",");
    issue.labels = [...issue.labels.filter((l) => !remove.includes(l)), ...(option("--add-label")[0]?.split(",") ?? [])];
    break;
  }
  case "issue comment":
    issueOf(args[2]).comments.push(input);
    break;
  case "issue close":
    issueOf(args[2]).state = "CLOSED";
    break;
  case "issue reopen":
    issueOf(args[2]).state = "OPEN";
    break;
  case "pr list":
    out = JSON.stringify(Object.entries(state.prs).map(([number, labels]) => ({ number: Number(number), labels: named(labels) })));
    break;
  case "pr edit":
    state.prs[args[2]].push(...option("--add-label")[0].split(","));
    break;
  default:
    process.stderr.write(`fake gh: unsupported command ${args.join(" ")}\n`);
    process.exit(1);
}

writeFileSync(path, JSON.stringify(state));
process.stdout.write(out);
