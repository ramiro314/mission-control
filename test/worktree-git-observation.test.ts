import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/server/util/exec.ts";
import { worktreeRepositoryIdentity } from "../src/server/util/git.ts";
import { NativeWorktreeGit, OBSERVATION_GIT_OPTIONS } from "../src/server/worktrees/git.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

// A Git read that may take `index.lock` can leave it behind when it is killed, and the slot's
// next reset then fails with "File exists". So every read observation uses passes
// `--no-optional-locks` before its subcommand, and no mutation does. Real Git runs underneath;
// the executor only records each argv.

const calls: string[][] = [];
const git = new NativeWorktreeGit((bin, args, opts) => {
  if (bin === "git") calls.push([...args]);
  return run(bin, args, opts);
});

async function argvOf(operation: () => Promise<unknown>): Promise<string[][]> {
  calls.length = 0;
  await operation();
  return [...calls];
}

const FLAG = OBSERVATION_GIT_OPTIONS[0];

/** Everything after `-C <dir>`: the global options, then the subcommand and its arguments. */
function afterDirectory(args: readonly string[]): string[] {
  assert.equal(args[0], "-C", `argv starts with -C: ${args.join(" ")}`);
  return args.slice(2);
}

/** A Git command that writes: the work tree, the index, a ref, or a registration. */
function isMutation(args: readonly string[]): boolean {
  const rest = afterDirectory(args).filter((arg) => arg !== FLAG);
  const [command, sub] = rest;
  if (command === "worktree") return sub === "add" || sub === "remove";
  // `symbolic-ref <name> <ref>` sets the symref; with one positional it only reads it.
  if (command === "symbolic-ref") return rest.slice(1).filter((arg) => !arg.startsWith("-")).length === 2;
  return ["checkout", "reset", "clean", "fetch", "update-ref"].includes(command ?? "");
}

function assertObservation(argvs: string[][], label: string): void {
  assert.ok(argvs.length > 0, `${label} ran Git`);
  for (const args of argvs) {
    assert.equal(afterDirectory(args)[0], FLAG, `${label}: ${args.join(" ")} puts ${FLAG} before the subcommand`);
    assert.equal(isMutation(args), false, `${label}: ${args.join(" ")} is a read`);
  }
}

function assertMutationsUnflagged(argvs: string[][], label: string, expected: string): void {
  const mutations = argvs.filter(isMutation);
  assert.ok(
    mutations.some((args) => afterDirectory(args).join(" ").startsWith(expected)),
    `${label} ran ${expected}: ${argvs.map((args) => args.join(" ")).join("; ")}`,
  );
  for (const args of mutations) {
    assert.equal(args.includes(FLAG), false, `${label}: mutation ${args.join(" ")} takes its locks`);
  }
}

test("every observation argv puts --no-optional-locks before the subcommand, and no mutation argv does", async () => {
  const { root, clone } = mkOriginAndClone("mission-worktree-git-observation-");
  const base = gitIn(clone, "rev-parse", "HEAD");
  const identity = worktreeRepositoryIdentity(clone);
  assert.ok(identity, "the clone is a provable repository");
  const slot = join(root, "pool", "1", "repo");

  const add = await argvOf(async () => assert.equal((await git.add(identity, slot, base)).ok, true));
  assertMutationsUnflagged(add, "add", "worktree add");

  // The reads inventory, reconcile and acquisition make.
  assertObservation(await argvOf(async () => assert.equal((await git.list(identity)).ok, true)), "list");
  const inspect = await argvOf(async () => {
    const inspected = await git.inspect(slot);
    assert.equal(inspected.ok, true, inspected.ok ? "" : inspected.reason);
  });
  assertObservation(inspect, "inspect");
  for (const subcommand of ["rev-parse", "status", "symbolic-ref"]) {
    assert.ok(inspect.some((args) => afterDirectory(args)[1] === subcommand), `inspect runs ${subcommand}`);
  }
  assertObservation(
    await argvOf(async () => assert.equal((await git.observedDefaultSha(identity)).ok, true)),
    "observedDefaultSha",
  );
  assertObservation(
    await argvOf(async () => assert.deepEqual(await git.mergedInto(slot, base), { ok: true, value: true })),
    "mergedInto",
  );

  // Without a cached origin/HEAD the default is found by the fallback probes, which are reads too.
  gitIn(clone, "remote", "set-head", "origin", "-d");
  const fallback = await argvOf(async () => {
    const observed = await git.observedDefaultSha(identity);
    assert.deepEqual(observed, { ok: true, value: base });
  });
  assertObservation(fallback, "observedDefaultSha fallback");
  assert.ok(
    fallback.some((args) => afterDirectory(args).join(" ") === `${FLAG} rev-parse --verify --quiet origin/main`),
    `the fallback probed origin/main: ${fallback.map((args) => args.join(" ")).join("; ")}`,
  );
  gitIn(clone, "remote", "set-head", "origin", "main");

  // Return's fetch and the pool reset and removal write, and keep taking their locks.
  const fetched = await argvOf(async () => assert.equal((await git.fetchDefaultSha(identity)).ok, true));
  assertMutationsUnflagged(fetched, "fetchDefaultSha", "fetch");
  const reset = await argvOf(async () => assert.equal((await git.reset(slot, base)).ok, true));
  assertMutationsUnflagged(reset, "reset", "checkout");
  // The reset's own verification is still a read.
  assertObservation(reset.filter((args) => !isMutation(args)), "reset verification");
  const removed = await argvOf(async () => assert.equal((await git.remove(identity, slot, false)).ok, true));
  assertMutationsUnflagged(removed, "remove", "worktree remove");
  assertObservation(removed.filter((args) => !isMutation(args)), "remove's status read");
});
