import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scriptRepository } from "../scripts/checkout-repository.mjs";

// What is at stake: on this fork, a `gh` call that names no repository picks the `upstream`
// remote, the SAML-enforcing parent. Each repository script must name the checkout's own
// repository unless told otherwise, and fail with the resolver's message when it has none.

const root = join(import.meta.dirname, "..");
const tsx = fileURLToPath(import.meta.resolve("tsx"));
const scratch = mkdtempSync(join(tmpdir(), "script-checkout-repository-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

// Records every argv as a JSON line and answers every list with nothing.
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "gh"),
  '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.GH_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write("[]");\n',
);
chmodSync(join(bin, "gh"), 0o755);

// Every fixture remote fetches from one local repository through `insteadOf`, so fork-report's
// `git fetch` works offline while the configured URLs still name their hosts.
const mirror = join(scratch, "mirror.git");
execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", mirror]);
const seed = join(scratch, "seed");
execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
writeFileSync(join(seed, "package.json"), '{"version":"1.0.0"}\n');
const inSeed = (...args: string[]) => execFileSync("git", ["-C", seed, ...args]);
inSeed("add", "package.json");
inSeed("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "seed");
inSeed("push", "--quiet", mirror, "main");

const FORK = "https://github.com/me/fork.git";
const PARENT = "https://github.com/parent/fork.git";
const GITLAB_ORIGIN = "git@gitlab.com:me/fork.git";
const GITLAB_UPSTREAM = "https://gitlab.com/parent/fork.git";

let checkouts = 0;
function checkout(remotes: Record<string, string>): string {
  const dir = join(scratch, `checkout-${checkouts++}`);
  execFileSync("git", ["init", "--quiet", dir]);
  for (const [name, url] of Object.entries(remotes)) execFileSync("git", ["-C", dir, "remote", "add", name, url]);
  for (const url of [FORK, PARENT, GITLAB_ORIGIN, GITLAB_UPSTREAM]) execFileSync("git", ["-C", dir, "config", "--add", `url.${mirror}.insteadOf`, url]);
  return dir;
}

const forkCheckout = () => checkout({ origin: FORK, upstream: PARENT });
const gitlabCheckout = () => checkout({ origin: GITLAB_ORIGIN, upstream: GITLAB_UPSTREAM });

interface Run {
  status: number | null;
  stderr: string;
  /** The `--repo` of every `gh` call, in order. */
  repos: (string | null)[];
}

function runScript(cwd: string, argv: string[], env: Record<string, string> = {}): Run {
  const log = join(cwd, "gh-args.log");
  rmSync(log, { force: true });
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_ARGS_LOG: log,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // Nothing reaches the network, even a regression that fetches a remote it should not.
    GIT_ALLOW_PROTOCOL: "file",
    ...env,
  };
  if (!("GH_REPO" in env)) delete childEnv.GH_REPO;
  delete childEnv.MISSION_GH_BIN;
  const result = spawnSync(process.execPath, argv, { cwd, env: childEnv, encoding: "utf8" });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];
  return {
    status: result.status,
    stderr: result.stderr,
    repos: calls.map((args) => (args.includes("--repo") ? (args[args.indexOf("--repo") + 1] ?? null) : null)),
  };
}

const scripts: { name: string; argv: (cwd: string) => string[]; takesRepoFlag: boolean; okStatus: number; errorStatus: number; prefix: string }[] = [
  {
    name: "fork-report",
    argv: (cwd) => [join(root, "scripts/fork-report.mjs"), "--out", join(cwd, "report.md")],
    takesRepoFlag: true,
    okStatus: 0,
    errorStatus: 1,
    prefix: "fork-report: ",
  },
  {
    name: "fork-delta",
    argv: () => [join(root, "scripts/fork-delta.mjs"), "pending"],
    takesRepoFlag: true,
    okStatus: 0,
    // 3, not 2: the section is fine, the run could not finish.
    errorStatus: 3,
    prefix: "fork-delta: ",
  },
  {
    name: "unit-shard-timings",
    argv: () => ["--import", tsx, join(root, "scripts/unit-shard-timings.ts"), "123"],
    takesRepoFlag: false,
    // The fake run has no artifacts, so the script stops after its one `gh` call and writes nothing.
    okStatus: 1,
    errorStatus: 1,
    prefix: "test:timings: ",
  },
];

for (const script of scripts) {
  test(`${script.name} names origin, not upstream, when given no repository`, () => {
    const run = runScript(forkCheckout(), script.argv(scratch));
    assert.equal(run.status, script.okStatus, run.stderr);
    assert.ok(run.repos.length > 0);
    assert.deepEqual(new Set(run.repos), new Set(["me/fork"]));
  });

  test(`${script.name} prefers GH_REPO over the checkout`, () => {
    const run = runScript(forkCheckout(), script.argv(scratch), { GH_REPO: "env/repo" });
    assert.equal(run.status, script.okStatus, run.stderr);
    assert.deepEqual(new Set(run.repos), new Set(["env/repo"]));
  });

  if (script.takesRepoFlag) {
    test(`${script.name} prefers an explicit --repo over GH_REPO and the checkout`, () => {
      const run = runScript(forkCheckout(), [...script.argv(scratch), "--repo", "flag/repo"], { GH_REPO: "env/repo" });
      assert.equal(run.status, script.okStatus, run.stderr);
      assert.deepEqual(new Set(run.repos), new Set(["flag/repo"]));
    });
  }

  test(`${script.name} exits with the resolver's message for a checkout with no GitHub origin`, () => {
    const cwd = gitlabCheckout();
    const run = runScript(cwd, script.argv(scratch));
    assert.equal(run.status, script.errorStatus);
    assert.deepEqual(run.repos, []);
    assert.equal(
      run.stderr.trim(),
      `${script.prefix}No GitHub repository for ${cwd}: origin is ${GITLAB_ORIGIN}, ` +
        `upstream is ${GITLAB_UPSTREAM}; no gh default is set. ` +
        "Point origin at GitHub, or run `gh repo set-default`.",
    );
  });
}

test("fork-delta reports a usage error before reading the checkout", () => {
  const run = runScript(gitlabCheckout(), [join(root, "scripts/fork-delta.mjs")]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^fork-delta: usage:/);
});

test("scriptRepository follows a gh default pin over origin", () => {
  const cwd = forkCheckout();
  execFileSync("git", ["-C", cwd, "config", "remote.upstream.gh-resolved", "base"]);
  assert.equal(scriptRepository(undefined, { cwd, env: {} }), "parent/fork");
});

test("scriptRepository reports a checkout with no remotes through the resolver", () => {
  const cwd = checkout({});
  assert.throws(() => scriptRepository(undefined, { cwd, env: {} }), {
    message: `No GitHub repository for ${cwd}: it has no remotes; no gh default is set. Point origin at GitHub, or run \`gh repo set-default\`.`,
  });
});

test("scriptRepository reports a directory git cannot read", () => {
  const cwd = join(scratch, "missing");
  assert.throws(() => scriptRepository(undefined, { cwd, env: {} }), {
    message: new RegExp(`^Could not read the git remotes of ${cwd}: `),
  });
});
