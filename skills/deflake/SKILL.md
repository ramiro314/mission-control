---
name: deflake
description: Fix a flaky test at its cause rather than retrying or silencing it - reproduce the flake under load first, find the timing or ordering dependency, fix it, prove the fix with a before and after repeated run at the same load, and close the flake issue from the fix pull request. Use when a task comes from a "Flaky test:" GitHub issue, carries the flaky-test label, or asks you to deflake, stabilize, or fix an intermittent or flaky test.
metadata:
  mission:
    category: testing
    enforcement: triggered
---

# Deflake

A flaky test passes and fails on the same code. It is almost never random: something in it
depends on timing, ordering, or shared state that a busy CI runner exposes and an idle laptop
hides. Your job is to find that dependency and remove it, and to prove you did.

The rule that shapes every step below: **reproduce first.** A change made before you have seen
the test fail on your machine is a guess, and a green run afterwards proves nothing, because
the test was usually green before too.

## 1. Read the issue

A flake issue written by Mission Control's CI action looks like this:

- Title `Flaky test: <name> (<file>)`.
- Body starting with `<!-- mission-flake:v1 key=<key> -->`, naming the test, file and runner,
  with the first occurrence.
- One comment per later occurrence, each starting with
  `<!-- mission-flake-occurrence:v1 at=<ISO time> -->` and
  `<!-- mission-flake-run:v1 url=<run URL> -->`, then the PR or branch, the commit, the run
  link, the jobs and the error snippet.

Read all of it: `gh issue view <n> --comments`. Collect every error snippet, and note which
branches, jobs and dates they came from. Different snippets for one test often mean two races,
not one. A flake seen only in one shard or one runtime version is a clue about what it shares
with its neighbours.

Then read the test and the code it exercises. Look for the usual suspects: a fixed `sleep` or
timeout standing in for "wait until ready", a poll that assumes an order, a port, file, temp
directory, database or environment variable shared with another test, a timer or clock read
twice, an unawaited promise, a listener attached after the event it waits for, and teardown
that races the next test.

## 2. Reproduce it under load, and measure it

Before changing anything, make the test fail on your machine and record how often it fails.

1. **Repeat it.** Run only the flaky test many times (50 to 200 runs, more for a rare flake).
   Use the runner's own repeat support where it has one (Playwright `--repeat-each`,
   `pytest --count`), or a shell loop that counts failures:

   ```sh
   fails=0; for i in $(seq 1 100); do <run the one test> >/dev/null 2>&1 || fails=$((fails+1)); done; echo "$fails/100"
   ```

   In this repository a single `node:test` file is
   `node --test --import ./test/setup-state.mjs --import tsx <file>`.
2. **Raise concurrency.** Run it alongside the rest of its file or shard, with more workers than
   usual (`MISSION_TEST_CONCURRENCY=8 npm test`, Playwright `--workers`), so shared state and
   ordering get exercised.
3. **Starve the CPU.** CI runners are slower and busier than your machine. Run a CPU-heavy
   process alongside, one per core, for example `yes > /dev/null &` repeated, and kill them
   afterwards.

Write the result down as a failure rate with the exact command and load, for example
"7/100 failed with 8 `yes` processes and `--workers=6`". That line is your **before**.

If nothing reproduces after a real effort, do not invent a fix. Say what you tried and the
rates you measured on the issue, and stop there or add the diagnostics that would catch it next
time. A fix you cannot show failing first is not a fix.

## 3. Fix the cause

Find the timing or ordering dependency the failures point at and remove it:

- Wait for the condition, not for a duration: poll for the state the test needs, or await the
  event that produces it.
- Give each test its own port, directory, database or fixture instead of sharing one.
- Make the order explicit: await the setup, attach the listener before triggering the event,
  finish teardown before the next test starts.
- Inject or freeze the clock instead of reading real time twice.

The fix can be in the test or in the product code. A race in the product that a test caught is
a real bug, and fixing it there is the better outcome.

**Loosen a timeout only when the limit itself is wrong** - when the work legitimately takes
longer than the limit on a loaded runner, not when the test is waiting for something it should
await. If you do raise one, say in the pull request why the old limit was wrong and what the
work actually takes under load. Never add retries, skip the test, or quarantine it as the fix.

## 4. Prove it with a before and after run

Run the **same** command under the **same** load as step 2, with the same number of runs, and
record the result. That is your **after**. The proof is the pair:

```
before: 7/100 failed  (8 x `yes`, --workers=6)
after:  0/100 failed  (8 x `yes`, --workers=6)
```

If the before rate was low, run more times after, enough that zero failures means something.
Then run the test's whole file or suite normally to make sure nothing else broke.

## 5. Commit the fix and report

Commit the fix and report the task complete. Do not push or open a pull request yourself: the
task's bound workflow opens it with its Pull Request action, or Foreman's wrap-up does when no
workflow is bound. The pull-request skill writes the description from your report, so the
report and the commit message carry what the pull request needs:

- `Fixes #<issue>`, in both the commit message and the completion report, so the pull request
  description carries it and merging closes the flake issue. Mission Control's CI action then
  drops the actionable label, and reopens the issue if the test flakes again.
- The cause in one or two sentences, the fix, and the before and after runs with their exact
  commands and load.
- If you raised a timeout, why the limit itself was wrong.
