import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The worker resolves its state dir at load, so the home is seeded before the import.
const home = mkdtempSync(join(tmpdir(), "inspector-deny-"));
const state = join(home, "state");
mkdirSync(state);
process.env.HARNESS_HOME = state;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const {
  DENY_PATHS,
  STATE_CARVE_OUTS,
  inspectorDenyPaths,
  renderDenyPaths,
  stateEntryClassified,
} = await import("../src/server/inspector/deny-paths.ts");

/** Claude Code's rule glob (`//abs`, `*`, `**`) as a matcher for absolute paths. */
function denied(rules: readonly string[], path: string): boolean {
  return rules.some((r) => {
    if (!r.startsWith("//")) return false;
    const source = r.slice(1).split(/(\*\*|\*)/).map((part) =>
      part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("");
    return new RegExp(`^${source}$`).test(path);
  });
}

// The entries the Linux readiness plan (F2, R15) names, denied whether or not they exist.
const PLAN_FILES = [
  "harness.db", "harness.db-wal", "harness.db-shm", "token", "scout-submission.key",
  "scout-producer.json", "install-receipt.json", "pi-extension.json", "daemon.lock",
  "daemon.log", "foreman.log", "update.log",
];
const PLAN_DIRS = [
  "backups", "archives", "uploads", "workflow-evidence", "scouts", "scout-submission-credentials",
  "ask-channel", "installers", "bin", "check-worktrees", "pi-extension.lock.d",
];

test("an empty Linux state dir still denies every named entry and never the carve-outs", () => {
  const rules = renderDenyPaths("linux", "/home/op", state);
  for (const f of PLAN_FILES) assert.ok(denied(rules, join(state, f)), `${f} is readable`);
  for (const d of PLAN_DIRS) assert.ok(denied(rules, join(state, d, "x", "y")), `${d}/ is readable`);
  for (const f of ["update.log.1", "install-receipt.json.123.tmp", "foreman-spend-outbox.ab.json"]) {
    assert.ok(denied(rules, join(state, f)), `${f} is readable`);
  }
  for (const carve of STATE_CARVE_OUTS) {
    assert.equal(denied(rules, join(state, carve, "pool", "repo", "src", "a.ts")), false, `${carve} is denied`);
  }
  for (const secret of [".ssh/id_ed25519", ".aws/credentials", ".claude/.credentials.json"]) {
    assert.ok(denied(rules, join("/home/op", secret)), `~/${secret} is readable`);
  }
  assert.ok(rules.includes("**/.credentials.json"));
});

test("Linux denies an unknown entry present at spawn, including one created after load", () => {
  mkdirSync(join(state, "worktree-pools", "1", "repo"), { recursive: true });
  mkdirSync(join(state, "worktrees", "t1"), { recursive: true });
  const before = inspectorDenyPaths("linux");
  assert.equal(denied(before, join(state, "late-dir", "secret")), false);

  mkdirSync(join(state, "late-dir"));
  writeFileSync(join(state, "late-file.json"), "{}");
  const after = inspectorDenyPaths("linux");
  assert.ok(denied(after, join(state, "late-dir", "secret")), "a directory created after load is readable");
  assert.ok(denied(after, join(state, "late-file.json")), "a file created after load is readable");
  assert.equal(denied(after, join(state, "worktree-pools", "1", "repo", "a.ts")), false);
  assert.equal(denied(after, join(state, "worktrees", "t1", "a.ts")), false);
});

test("a symlinked Linux state dir or home is denied as spelled and as resolved", () => {
  const link = join(home, "state-link");
  symlinkSync(state, link);
  const rules = renderDenyPaths("linux", link, link);
  assert.ok(denied(rules, join(link, "harness.db")));
  assert.ok(denied(rules, join(state, "harness.db")));
  assert.ok(denied(rules, join(state, ".ssh", "id_rsa")));
  assert.equal(denied(rules, join(state, "worktree-pools", "a.ts")), false);
});

test("macOS keeps its constant list and its whole-state-dir rule", () => {
  assert.equal(inspectorDenyPaths("darwin"), DENY_PATHS);
  assert.deepEqual(renderDenyPaths("darwin", "/Users/op", state).slice(-4), [
    "//Users/op/.aws/**",
    "//Users/op/.ssh/**",
    "//Users/op/.claude/**",
    "//Users/*/.mission-control/**",
  ]);
});

// The guard: every state-dir entry the code builds has to be classified, so adding one
// means deciding whether the Inspector may read it.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx|mjs|mts)$/.test(e.name) && !e.name.endsWith(".d.mts") ? [path] : [];
  });
}

/** `{ file, entry }` for every `join`/`resolve` rooted at the state dir, or `entry: null`. */
function definedStateEntries(): Array<{ file: string; expr: string; entry: string | null }> {
  const found: Array<{ file: string; expr: string; entry: string | null }> = [];
  for (const path of [...sources(join(ROOT, "src")), ...sources(join(ROOT, "scripts"))]) {
    const text = readFileSync(path, "utf8");
    if (!/\bSTATE_DIR\b|\bstateDir\(\)/.test(text)) continue;
    const consts = new Map(
      [...text.matchAll(/\bconst\s+(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1]!, m[2]!] as const),
    );
    // Locals that hold the state dir: `const state = stateDir()`, `directory = stateDir()`.
    const aliases = new Set(["STATE_DIR", "stateDir\\(\\)"]);
    for (const m of text.matchAll(/\b(\w+)\s*=\s*(?:[\w.]+\s*\?\?\s*)?(?:STATE_DIR\b|stateDir\(\))/g)) {
      aliases.add(m[1]!);
    }
    const call = new RegExp(`\\b(?:join|resolve)\\(\\s*(?:${[...aliases].join("|")})\\s*,\\s*([^,)]+)`, "g");
    for (const m of text.matchAll(call)) {
      const expr = m[1]!.trim();
      let value: string | undefined;
      if (/^"[^"]*"$/.test(expr)) value = expr.slice(1, -1);
      else if (/^`[^`]*`$/.test(expr)) {
        value = expr.slice(1, -1).replace(/\$\{(\w+)\}/g, (_, id: string) => consts.get(id) ?? "*");
      } else value = consts.get(expr);
      found.push({ file: relative(ROOT, path), expr, entry: value === undefined ? null : value.split("/")[0]! });
    }
  }
  return found;
}

test("every state-dir entry the code defines is named or carved out", () => {
  const found = definedStateEntries();
  // The scan must keep finding the definitions it exists for.
  for (const known of ["harness.db", "worktree-pools", "daemon.lock", "pi-extension.lock.d", "app-src"]) {
    assert.ok(found.some((f) => f.entry === known), `the scan no longer finds ${known}`);
  }
  const unresolved = found.filter((f) => f.entry === null);
  assert.deepEqual(unresolved, [], "resolve these to a literal so the guard can classify them");
  const unclassified = found.filter((f) => !stateEntryClassified(f.entry!));
  assert.deepEqual(
    unclassified,
    [],
    "classify each new state-dir entry in src/server/inspector/deny-paths.ts: a named deny entry, or a carve-out",
  );
});
