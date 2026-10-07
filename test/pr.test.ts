import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PrMatch } from "../src/server/registry.ts";
import { writeFakeExecutable } from "./helpers/fake-executable.ts";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-pr-"));
const { Registry, prNumberFromUrl } = await import("../src/server/registry.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");
const { currentMergeability } = await import("../src/shared/pr-mergeable.ts");

function disco(over: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    syntheticId: "s",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/wt",
    gitBranch: "feat/x",
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: null,
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

const PR = "https://github.com/o/r/pull/42";

function match(over: Partial<PrMatch> = {}): PrMatch {
  const result: PrMatch = {
    url: PR,
    number: 42,
    state: "open",
    checks: null,
    branch: "feat/x",
    agentSessionId: null,
    episodeId: null,
    createdAt: null,
    mergedAt: null,
    headSha: null,
    worktreeHeadSha: null,
    ...over,
  };
  if (result.state === "merged" && result.mergedAt === null) result.mergedAt = Date.now();
  return result;
}

test("reconcilePrs sets the open PR on the matching session", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);

  reg.reconcilePrs(new Map([["feat", match()]]), new Set());

  assert.equal(reg.getSession("feat")!.prUrl, PR);
  assert.equal(reg.getSession("feat")!.prNumber, 42);
  assert.equal(reg.getSession("feat")!.prState, "open");
  assert.equal(reg.getSession("feat")!.prChecks, null);
});

test("reconcilePrs tracks the PR's CI check status as it changes", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);

  // Checks start pending, then one fails: the card keys its alert off "failing".
  reg.reconcilePrs(new Map([["feat", match({ checks: "pending" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prChecks, "pending");

  reg.reconcilePrs(new Map([["feat", match({ checks: "failing" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prChecks, "failing");

  // A re-run turns them green again -> the alert clears.
  reg.reconcilePrs(new Map([["feat", match({ checks: "passing" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prChecks, "passing");
});

test("a merged PR flips the chip to merged and lingers while on the branch", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["feat", match()]]), new Set());

  // The PR merges: the poller still finds it (state=all) and reports it merged.
  reg.reconcilePrs(new Map([["feat", match({ state: "merged" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prUrl, PR);
  assert.equal(reg.getSession("feat")!.prState, "merged");

  // A later sweep still reporting it merged keeps the chip (no branch change yet).
  reg.reconcilePrs(new Map([["feat", match({ state: "merged" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prState, "merged");
});

test("reconcilePrs clears the chip once the branch has no matching PR", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["feat", match()]]), new Set());
  assert.equal(reg.getSession("feat")!.prUrl, PR);

  // Next sweep: gh finds no open/merged PR for the branch (branch moved, or the
  // PR was closed unmerged) -> absent from `found` -> cleared.
  reg.reconcilePrs(new Map(), new Set());

  assert.equal(reg.getSession("feat")!.prUrl, null);
  assert.equal(reg.getSession("feat")!.prNumber, null);
  assert.equal(reg.getSession("feat")!.prState, null);
});

test("reconcilePrs leaves the chip untouched when gh errored (session in skip)", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["feat", match({ state: "merged" })]]), new Set());

  // gh missing/unauthenticated this tick -> skip -> a transient failure must not
  // wipe a real chip (even a merged one).
  reg.reconcilePrs(new Map(), new Set(["feat"]));

  assert.equal(reg.getSession("feat")!.prUrl, PR);
  assert.equal(reg.getSession("feat")!.prState, "merged");
});

test("a reset-and-reused session drops the old chip, then shows the new PR", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "s1", gitBranch: "feat/x" })]);
  reg.reconcilePrs(new Map([["s1", match({ state: "merged" })]]), new Set());
  assert.equal(reg.getSession("s1")!.prUrl, PR);

  // The session is reset onto a fresh branch: discovery updates the branch, and
  // the next reconcile (branch's PR not in `found`) retracts the merged chip.
  reg.applyDiscovery([disco({ syntheticId: "s1", gitBranch: "feat/y" })]);
  reg.reconcilePrs(new Map(), new Set());
  assert.equal(reg.getSession("s1")!.prUrl, null);
  assert.equal(reg.getSession("s1")!.prState, null);

  // A PR is opened on the new branch -> the chip repopulates.
  const pr2 = "https://github.com/o/r/pull/43";
  reg.reconcilePrs(
    new Map([["s1", match({ url: pr2, number: 43, branch: "feat/y" })]]),
    new Set(),
  );
  assert.equal(reg.getSession("s1")!.prUrl, pr2);
  assert.equal(reg.getSession("s1")!.prNumber, 43);
  assert.equal(reg.getSession("s1")!.prState, "open");
});

test("prPollTargets drops sessions without a cwd and exited sessions", () => {
  const reg = new Registry();
  reg.applyDiscovery([
    disco({ syntheticId: "ok", cwd: "/wt", gitBranch: "feat/x" }),
    disco({ syntheticId: "nocwd", cwd: null, gitBranch: "feat/x" }),
  ]);
  // Drop "ok" from discovery so it transitions to the exited state.
  reg.applyDiscovery([disco({ syntheticId: "nocwd", cwd: null, gitBranch: "feat/x" })]);

  const targets = reg.prPollTargets();
  assert.equal(
    targets.find((t) => t.id === "ok"),
    undefined,
  );
  assert.equal(
    targets.find((t) => t.id === "nocwd"),
    undefined,
  );
});

test("prNumberFromUrl parses the PR number, else null", () => {
  assert.equal(prNumberFromUrl("https://github.com/o/r/pull/123"), 123);
  assert.equal(prNumberFromUrl("https://github.com/o/r/tree/main"), null);
});

// ---- mergeability -------------------------------------------------------------------------
//
// Bound to the head GitHub reported it for, so a kept observation never describes a head it
// was not made on, and set and cleared with `prState`.

test("a CONFLICTING read lands bound to its head, with the base", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(
    new Map([["feat", match({ headSha: "A", mergeable: "conflicting", baseRef: "main" })]]),
    new Set(),
  );
  const s = reg.getSession("feat")!;
  assert.deepEqual(s.prMergeable, { state: "conflicting", headSha: "A" });
  assert.equal(s.prBaseRef, "main");
  assert.equal(s.prHeadSha, "A");
  assert.equal(currentMergeability(s), "conflicting");
});

test("UNKNOWN keeps the observation with its old head while prHeadSha advances", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(
    new Map([["feat", match({ headSha: "A", mergeable: "conflicting", baseRef: "main" })]]),
    new Set(),
  );
  reg.reconcilePrs(
    new Map([["feat", match({ headSha: "A", mergeable: null, baseRef: "main" })]]),
    new Set(),
  );
  assert.equal(currentMergeability(reg.getSession("feat")!), "conflicting", "same head: still known");

  reg.reconcilePrs(
    new Map([["feat", match({ headSha: "B", mergeable: null, baseRef: "main" })]]),
    new Set(),
  );
  const s = reg.getSession("feat")!;
  assert.deepEqual(s.prMergeable, { state: "conflicting", headSha: "A" });
  assert.equal(s.prHeadSha, "B");
});

test("push, then UNKNOWN, then resolved: conflicting on A, unknown on B, then mergeable on B", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  const read = (over: Partial<PrMatch>) =>
    reg.reconcilePrs(new Map([["feat", match({ baseRef: "main", ...over })]]), new Set());

  read({ headSha: "A", mergeable: "conflicting" });
  assert.equal(currentMergeability(reg.getSession("feat")!), "conflicting");
  read({ headSha: "B", mergeable: null });
  assert.equal(currentMergeability(reg.getSession("feat")!), null);
  read({ headSha: "B", mergeable: "mergeable" });
  assert.equal(currentMergeability(reg.getSession("feat")!), "mergeable");
});

test("a merged PR clears the observation, and a closed one clears all three fields", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "feat", gitBranch: "feat/x" })]);
  reg.reconcilePrs(
    new Map([["feat", match({ headSha: "A", mergeable: "conflicting", baseRef: "main" })]]),
    new Set(),
  );
  reg.reconcilePrs(new Map([["feat", match({ state: "merged", headSha: "A" })]]), new Set());
  assert.equal(reg.getSession("feat")!.prMergeable, null);

  reg.applyDiscovery([disco({ syntheticId: "other", gitBranch: "feat/x" })]);
  reg.reconcilePrs(
    new Map([["other", match({ headSha: "A", mergeable: "conflicting", baseRef: "main" })]]),
    new Set(),
  );
  // Closed unmerged: the branch lookup drops it, so `found` no longer holds it.
  reg.reconcilePrs(new Map(), new Set());
  const s = reg.getSession("other")!;
  assert.equal(s.prState, null);
  assert.equal(s.prMergeable, null);
  assert.equal(s.prBaseRef, null);
  assert.equal(s.prHeadSha, null);
});

test("an exited session keeps its link until removal, and a by-URL read reaches it", () => {
  const reg = new Registry();
  reg.applyDiscovery([disco({ syntheticId: "gone", gitBranch: "feat/x" })]);
  reg.reconcilePrs(
    new Map([["gone", match({ headSha: "A", mergeable: "conflicting", baseRef: "main" })]]),
    new Set(),
  );
  reg.applyDiscovery([]);
  assert.equal(reg.getSession("gone")!.state, "exited");
  // Exited sessions are never polled, so the next branch pass must not read that as "no PR".
  reg.reconcilePrs(new Map(), new Set());
  assert.equal(reg.getSession("gone")!.prUrl, PR);

  // The fix lands: first GitHub is still computing on the new head, then it answers.
  reg.reconcilePrUrlMergeability(
    new Map([[PR, { open: true, mergeable: null, baseRef: "main", headSha: "B" }]]),
  );
  let s = reg.getSession("gone")!;
  assert.deepEqual(s.prMergeable, { state: "conflicting", headSha: "A" }, "UNKNOWN keeps it whole");
  assert.equal(currentMergeability(s), null);

  reg.reconcilePrUrlMergeability(
    new Map([[PR, { open: true, mergeable: "mergeable", baseRef: "main", headSha: "B" }]]),
  );
  s = reg.getSession("gone")!;
  assert.equal(currentMergeability(s), "mergeable");
  assert.equal(s.prState, "open", "a by-URL read writes only the mergeability fields");
});

test("the poller asks gh for mergeable, baseRefName and headRefOid on both paths", async () => {
  const home = process.env.HARNESS_HOME!;
  const bin = join(home, "fake-gh-bin");
  mkdirSync(bin, { recursive: true });
  const listOut = join(home, "gh-list.json");
  const viewOut = join(home, "gh-view.json");
  const argsLog = join(home, "gh-args.log");
  const gh = writeFakeExecutable(
    join(bin, "gh"),
    `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, args.join(" ") + "\\n");
const out = args[1] === "list" ? ${JSON.stringify(listOut)} : ${JSON.stringify(viewOut)};
try {
  process.stdout.write(fs.readFileSync(out));
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
`,
  );
  const repo = mkdtempSync(join(tmpdir(), "harness-pr-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  process.env.HARNESS_GH_BIN = gh;
  try {
    // Branch path: a live session on a feature branch whose PR conflicts.
    writeFileSync(
      listOut,
      JSON.stringify([
        {
          url: PR,
          number: 42,
          state: "OPEN",
          statusCheckRollup: [],
          createdAt: "2026-01-01T00:00:00Z",
          mergedAt: null,
          headRefOid: "A",
          mergeable: "CONFLICTING",
          baseRefName: "main",
        },
      ]),
    );
    const reg = new Registry();
    reg.applyDiscovery([disco({ syntheticId: "live", cwd: repo, gitBranch: "feat/x" })]);
    await pollAndReconcilePrs(reg, undefined, undefined, undefined, Date.now(), undefined, () => []);
    let s = reg.getSession("live")!;
    assert.equal(currentMergeability(s), "conflicting");
    assert.equal(s.prBaseRef, "main");

    // By-URL path: the session exits, and the URL is now seen only through the by-URL poller.
    reg.applyDiscovery([]);
    writeFileSync(
      viewOut,
      JSON.stringify({ state: "OPEN", mergedAt: null, mergeable: "MERGEABLE", baseRefName: "main", headRefOid: "B" }),
    );
    await pollAndReconcilePrs(reg, undefined, undefined, undefined, Date.now(), undefined, () => [PR]);
    s = reg.getSession("live")!;
    assert.equal(s.state, "exited");
    assert.equal(s.prHeadSha, "B");
    assert.equal(currentMergeability(s), "mergeable");
  } finally {
    delete process.env.HARNESS_GH_BIN;
  }
  const { readFileSync } = await import("node:fs");
  const calls = readFileSync(argsLog, "utf8");
  assert.match(calls, /pr list .*--json \S*mergeable\S*/);
  assert.match(calls, /pr list .*--json \S*baseRefName/);
  assert.match(calls, /pr view \S+ --json \S*mergeable/);
  assert.match(calls, /pr view \S+ --json \S*baseRefName/);
  assert.match(calls, /pr view \S+ --json \S*headRefOid/);
});
