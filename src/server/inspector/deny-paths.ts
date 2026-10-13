import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "../config.ts";

/**
 * Path rules handed to Claude Code itself, so they are enforced by the harness rather
 * than by asking the model nicely.
 *
 * The list is the obvious credential stores plus this app's own state: a reviewer that
 * could read `~/.claude` could read the operator's other projects' transcripts (and, on
 * Linux, `~/.claude/.credentials.json` holds the OAuth token in plaintext), and a reviewer
 * that could read `.git/config` could read a token embedded in a remote URL.
 *
 * Every path is denied for all THREE tools the reviewer holds, not just `Read`. `Grep`
 * takes an absolute path and prints the matching lines, so a `Read(...)`-only list
 * protects nothing it names; `Glob` confirms the files exist. The grant is what pays
 * for the tool access, so it has to cover the whole grant.
 */
const SECRET_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.git/config",
  "**/.npmrc",
  "**/.netrc",
  "**/credentials*",
  // `credentials*` cannot match a dot-prefixed name.
  "**/.credentials.json",
];

/**
 * Home-directory stores holding credentials in plaintext on a host with no keyring: Claude's
 * `.credentials.json`, Codex's `auth.json`, `gh`'s `hosts.yml` and Pi's `agent/auth.json`.
 * Every agent CLI here also keeps its transcripts beside them, so the whole tree is denied.
 */
const HOME_SECRET_DIRS = [".aws", ".ssh", ".claude", ".codex", ".config/gh", ".pi"];

/** macOS keeps its whole-state-dir rule unchanged (S13 in the Linux readiness plan). */
const DARWIN_STATE_RULE = "//Users/*/.mission-control/**";

/**
 * Every state-dir entry the code defines, denied on Linux whether or not it exists yet, so
 * an entry created while the Inspector runs is already covered. A file rule also covers
 * its `<name>*` siblings: SQLite's `-wal`/`-shm`, rotated logs, and atomic-write temps.
 * `test/inspector-deny-paths.test.ts` fails when the code defines an entry that is neither
 * here nor a carve-out.
 */
export const STATE_DENY_FILES = [
  "harness.db",
  "token",
  "scout-submission.key",
  "scout-producer.json",
  "install-receipt.json",
  "pi-extension.json",
  "daemon.lock",
  "daemon.log",
  "foreman.log",
  "update.log",
  "update-outcome.json",
  "foreman-spend-outbox.*",
  "foreman-spend-quarantine.*",
] as const;

export const STATE_DENY_DIRS = [
  "backups",
  "archives",
  "uploads",
  "workflow-evidence",
  "scouts",
  "scout-submission-credentials",
  "ask-channel",
  "installers",
  "bin",
  "check-worktrees",
  "pi-extension.lock.d",
  "integrations",
  "app-src",
  "staged-install-*",
  ".pi-extension-*",
  "database-recovery",
] as const;

/** Dispatched worktrees live in the state dir, and the Inspector reviews one of them. */
export const STATE_CARVE_OUTS = ["worktrees", "worktree-pools"] as const;

/**
 * The named list as top-level globs. Each one is denied both as an entry and as a tree, so a
 * name that matches is covered whatever its type: a `token-cache/` directory under the
 * `token*` file glob, or a `.pi-extension-x` file under the `.pi-extension-*` dir glob.
 */
const NAMED_GLOBS = [
  ...STATE_DENY_FILES.map((f) => f.endsWith("*") ? f : `${f}*`),
  ...STATE_DENY_DIRS,
];

/** A single path segment's glob (`*` only) as a matcher. */
function segmentMatcher(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}
const NAMED = NAMED_GLOBS.map(segmentMatcher);

/** Is a top-level state-dir entry already covered by the named list or carved out? */
export function stateEntryClassified(name: string): boolean {
  return (STATE_CARVE_OUTS as readonly string[]).includes(name) || NAMED.some((m) => m.test(name));
}

/**
 * The path as spelled and, when different, as resolved. The reviewer's cwd is a realpath,
 * so a rule rooted only at a symlinked home or state dir would miss every read through it.
 */
function roots(path: string): string[] {
  try {
    const real = realpathSync(path);
    return real === path ? [path] : [path, real];
  } catch {
    return [path];
  }
}

/** Claude Code writes an absolute path as `//abs/path`. */
const rule = (path: string) => `/${path}`;

function stateDirRules(stateDir: string): string[] {
  let extra: string[] = [];
  try {
    extra = readdirSync(stateDir)
      .filter((name) => !stateEntryClassified(name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // A missing or unreadable state dir still gets every named entry below.
  }
  // Entry and tree for every name, so its type at spawn (or later) cannot open a gap.
  const entries = [...NAMED_GLOBS, ...extra].flatMap((e) => [e, `${e}/**`]);
  return roots(stateDir).flatMap((root) => entries.map((e) => rule(join(root, e))));
}

/**
 * The Inspector's deny rules for `platform`.
 *
 * macOS keeps its whole-state-dir rule, which also covers its dispatched worktrees (S13).
 * Everywhere else the state-dir rule is rooted at the resolved state dir and fails closed:
 * every named entry, plus every other top-level entry present now, apart from the
 * worktree carve-outs a blanket rule would take from the reviewer.
 */
export function renderDenyPaths(platform: NodeJS.Platform, home: string, stateDir: string): string[] {
  const homeRules = roots(home).flatMap((h) => HOME_SECRET_DIRS.map((d) => rule(join(h, d, "**"))));
  return [
    ...SECRET_PATTERNS,
    ...homeRules,
    ...(platform === "darwin" ? [DARWIN_STATE_RULE] : stateDirRules(stateDir)),
  ];
}

/** macOS's deny list, a constant built once at load. Also the tests' representative grant. */
export const DENY_PATHS: readonly string[] = renderDenyPaths("darwin", homedir(), STATE_DIR);

/**
 * The deny list for one Inspector spawn. Off macOS it is rebuilt every call, so an entry
 * created in the state dir after the daemon started is covered from the next spawn.
 */
export function inspectorDenyPaths(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === "darwin" ? DENY_PATHS : renderDenyPaths(platform, homedir(), STATE_DIR);
}

/** The `--settings` payload a deny list renders to, every path for every review tool. */
export function denySettings(paths: readonly string[]): string {
  return JSON.stringify({
    permissions: {
      deny: paths.flatMap((p) => [`Read(${p})`, `Grep(${p})`, `Glob(${p})`]),
    },
  });
}

/**
 * Exported alongside `REVIEW_TOOLS` and `DENY_PATHS` so `llm-runner-contract.test.ts` can
 * assert that the `LlmRunner` tool grant renders this EXACT string. The Inspector is the
 * only caller that holds tools, so it is the one that decides whether that interface fits;
 * pinning the equality now is what makes the item that migrates this call site a provable
 * no-op rather than a hopeful one.
 */
export const DENY_SETTINGS = denySettings(DENY_PATHS);
