import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

import { PR_CREATE_RE, originRepositoryShell } from "../src/shared/pr-command.mjs";

// The regression guard for the SAML refusal (docs/plans/saml-safe-github-calls, section 7).
//
// A `gh` call that names no repository is resolved through gh's base-repository choice, which
// outside a terminal prefers a remote called `upstream`. On a fork of an organization that
// enforces SAML SSO that is the parent, and the call is refused. Every fix so far was local to
// one call site, so this file makes the choice a test failure instead of a code review catch:
// every `gh` call in the daemon, the app and the scripts is classified below, and every line of
// agent instructions that names a `gh` command is held to naming its repository.

const ROOT = join(import.meta.dirname, "..");

// ---- part 1: the call-site inventory ----

/**
 * How a call tells gh which repository it means.
 *
 * - `resolver`: `--repo` from `checkoutGitHubRepository` / `scriptRepository`, the shared
 *   resolver (gh default pin, else origin; never gh's own choice).
 * - `url`: a GitHub URL names the repository.
 * - `explicit`: the repository is spelled out - a `repos/<owner>/<repo>` REST path, GraphQL
 *   `owner`/`name` variables, or `--repo` with a configured or canonical repository.
 * - `node-id`: a GraphQL mutation on a global node id, which names one object and no repository
 *   gh could choose. Restricted like `none` (`NODE_ID_ARGV`): it names no repository, so each
 *   call that uses it is listed there and called out in the pull request that adds it.
 * - `none`: no repository at all. Only `auth status`, `--version` and `api user` may say so
 *   (`NO_REPOSITORY_ARGV`); any other call that names no repository is fixed, not classified.
 */
type Targeting = "resolver" | "url" | "explicit" | "node-id" | "none";

interface GhCall {
  /** The enclosing named function, `Class.method`, or `<module>`; `<shell>` for a shell script. */
  fn: string;
  /** The argv expression exactly as the scanner reads it (`normalize`), or a shell command. */
  argv: string;
  how: Targeting | readonly Targeting[];
  why: string;
}

/** A `gh` binary the scanner found but cannot follow to a call: declared here or it fails. */
interface GhMention {
  fn: string;
  /** The trimmed source line the mention is on. */
  line: string;
  why: string;
}

/** The only argv a `none` row may carry. */
const NO_REPOSITORY_ARGV = new Set([
  '["--version"]',
  '["auth", "status"]',
  '["auth", "status", "--hostname", "github.com"]',
  '["api", "user", "--jq", ".login"]',
  // `scripts/install-app.mjs`: `authStatus: () => ["auth", "status"]`.
  "GH_ARGS.authStatus()",
]);

/** The only argv a `node-id` row may carry: the Inspector resolving a thread it read off the PR. */
const NODE_ID_ARGV = new Set([
  '["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-F", `threadId=${threadId}`]',
]);

/**
 * Every `gh` call the scanner finds, by file. A call missing here fails, and so does a row no
 * call reads any more, so this stays the exact list rather than a superset.
 */
const GH_CALLS: Readonly<Record<string, readonly GhCall[]>> = {
  "src/main/updater.ts": [
    { fn: "latestMainCommit", argv: "UPDATE_GH_ARGS.mainCommit()", how: "explicit", why: "`repos/${CANONICAL_REPO}/commits/main`, through `runGh`" },
    { fn: "latestStableRelease", argv: "UPDATE_GH_ARGS.releaseList()", how: "explicit", why: "`--repo CANONICAL_REPO`, through `runGh`" },
    { fn: "latestStableRelease", argv: "UPDATE_GH_ARGS.releaseView(release.tagName)", how: "explicit", why: "`--repo CANONICAL_REPO`, through `runGh`" },
  ],
  "src/server/inspector/github.ts": [
    { fn: "authenticatedLogin", argv: '["api", "user", "--jq", ".login"]', how: "none", why: "the token's own login" },
    { fn: "fetchPr", argv: '["api", "graphql", "-f", `query=${PR_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${repo}`, "-F", `number=${number}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "fetchReviewPage", argv: '["api", "graphql", "-f", `query=${REVIEW_PAGE_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${repo}`, "-F", `number=${number}`, "-F", `before=${before}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "fetchThreadPage", argv: '["api", "graphql", "-f", `query=${THREAD_PAGE_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${repo}`, "-F", `number=${number}`, "-F", `after=${after}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "fetchDiff", argv: '["api", `repos/${owner}/${repo}/pulls/${number}`, "-H", "Accept: application/vnd.github.v3.diff"]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "postReview", argv: '["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-"]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "replyToComment", argv: '["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`, "--input", "-"]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "resolveThread", argv: '["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-F", `threadId=${threadId}`]', how: "node-id", why: "the review thread's global node id, read from that PR's own snapshot" },
    { fn: "mergePr", argv: '["api", "--method", "PUT", `repos/${owner}/${repo}/pulls/${number}/merge`, "--input", "-"]', how: "explicit", why: "owner and name parsed from the PR URL" },
  ],
  "src/server/pr.ts": [
    { fn: "queryPr", argv: "prListArgs(branch, repo.repo)", how: "resolver", why: "`--repo` from `checkoutGitHubRepository`; no gh call when it fails" },
    { fn: "queryPrUrl", argv: '["pr", "view", url, "--json", "state,mergedAt,mergeable,baseRefName,headRefOid"]', how: "url", why: "the adopted PR's URL" },
  ],
  "src/server/product-issues.ts": [
    { fn: "ProductIssueService.preflight", argv: '["--version"]', how: "none", why: "version probe" },
    { fn: "ProductIssueService.preflight", argv: '["auth", "status"]', how: "none", why: "authentication probe" },
    { fn: "ProductIssueService.preflight", argv: '["repo", "view", target.repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"]', how: "explicit", why: "the configured product-issues repository" },
    { fn: "ProductIssueService.preflight", argv: '["api", "--paginate", "--slurp", `repos/${target.repo}/labels?per_page=100`]', how: "explicit", why: "the configured product-issues repository" },
    { fn: "ProductIssueService.submit", argv: '["--version"]', how: "none", why: "attachment support probe" },
    { fn: "ProductIssueService.submit", argv: "productIssueCreateArgs(target.repo, draft, labels, attachmentArgs)", how: "explicit", why: "`--repo` with the configured product-issues repository" },
  ],
  "src/server/setup/index.ts": [
    { fn: "ghCliStatus", argv: '["--version"]', how: "none", why: "version probe, run on the path `present` resolved" },
    { fn: "ghAuthStatus", argv: '["auth", "status", "--hostname", "github.com"]', how: "none", why: "authentication probe" },
  ],
  "src/server/task-sources/github-issues.ts": [
    { fn: "sweep", argv: "ghIssueListArgs(cfg, target.repo)", how: "resolver", why: "`sourceRepository`: Repository, else `checkoutGitHubRepository`" },
    { fn: "preflight", argv: '["auth", "status"]', how: "none", why: "authentication probe" },
    { fn: "preflight", argv: "ghIssueListArgs({ ...cfg, limit: 1 }, target.repo)", how: "resolver", why: "`sourceRepository`, as the sweep" },
    { fn: "push", argv: "ghIssueCreateArgs(cfg, draft, target.repo)", how: "resolver", why: "`sourceRepository`, and the created URL is checked against it" },
    { fn: "annotate", argv: "ghIssueCommentArgs(ready.cfg, notice)", how: ["explicit", "url", "resolver"], why: "`issueTargetFor`: the item's `owner/repo#n` id, else its URL, else the resolved Repository (`writebackConfig`)" },
    { fn: "resolve", argv: "ghIssueCloseArgs(ready.cfg, notice)", how: ["explicit", "url", "resolver"], why: "`issueTargetFor`, as the comment" },
    { fn: "read", argv: "args", how: "url", why: "`ghLinkedIssueArgs` builds `issue view <url>` and throws for anything but the item's own issue URL" },
  ],
  "scripts/fork-delta.mjs": [
    { fn: "gh", argv: '[...args, "--repo", repo]', how: "resolver", why: "every caller passes `scriptRepository(values.repo)`" },
  ],
  "scripts/fork-migrate.mjs": [
    { fn: "ghRunner", argv: '[...args, "--repo", repo]', how: "explicit", why: "`--repo`, else `DEFAULT_REPO` (the fork)" },
  ],
  "scripts/fork-report.mjs": [
    { fn: "gh", argv: '[...args, "--repo", repo]', how: "resolver", why: "every caller passes `scriptRepository(values.repo)`" },
  ],
  "scripts/install-app.mjs": [
    { fn: "newestStableRelease", argv: "GH_ARGS.releaseList(repo)", how: "explicit", why: "`--repo`, defaulting to `CANONICAL_REPO`" },
    { fn: "checkPrerequisites", argv: '["--version"]', how: "none", why: "version probe" },
    { fn: "checkPrerequisites", argv: "GH_ARGS.authStatus()", how: "none", why: "authentication probe" },
  ],
  "scripts/unit-shard-timings.ts": [
    { fn: "main", argv: '["run", "download", runId, "--repo", repo, "--pattern", "unit-junit-node-*", "--dir", dir]', how: "resolver", why: "`scriptRepository()`" },
  ],
  "scripts/ci-tree-reuse.sh": [
    { fn: "<shell>", argv: 'gh api "repos/$REPO/commits/$SHA/pulls"', how: "explicit", why: "`REPO` is the workflow's `github.repository`" },
    { fn: "<shell>", argv: 'gh api "repos/$REPO/actions/workflows/$WORKFLOW/runs?event=pull_request&head_sha=$head&per_page=100"', how: "explicit", why: "`REPO` is the workflow's `github.repository`" },
    { fn: "<shell>", argv: 'gh run download "$run" --repo "$REPO" --name tested-tree --dir "$dir"', how: "explicit", why: "`REPO` is the workflow's `github.repository`" },
  ],
};

/** Each `gh` binary the scanner cannot follow to a call, and why it runs nothing unclassified. */
const GH_MENTIONS: Readonly<Record<string, readonly GhMention[]>> = {
  "src/main/updater.ts": [
    { fn: "runGh", line: "env: executable.env,", why: "the located gh's child environment, handed to the same `execFile` that runs it" },
  ],
  "src/server/config.ts": [
    { fn: "ghBin", line: 'return envVar("GH_BIN") || "gh";', why: "`ghBin()` itself; its calls are scanned" },
  ],
  "src/server/executables/catalog.ts": [
    { fn: "<module>", line: 'gh: spec("gh", "GitHub CLI", "gh", "GH_BIN"),', why: "the executable catalog entry" },
  ],
  "src/server/setup/index.ts": [
    { fn: "ghCliStatus", line: 'if (status.state !== "satisfied") return status;', why: "returns the setup status; the only run is the `--version` probe" },
    { fn: "ghCliStatus", line: "evidence: status.evidence,", why: "the resolved path, shown as setup evidence; the only run is the `--version` probe" },
    { fn: "ghCliStatus", line: "return status;", why: "returns the setup status; the only run is the `--version` probe" },
  ],
  "src/shared/executables.ts": [
    { fn: "<module>", line: '"gh",', why: "the executable id" },
  ],
  "src/shared/setup-catalog.ts": [
    { fn: "<module>", line: 'argv: ["brew", "install", "gh"],', why: "the install remedy's package name" },
  ],
  "scripts/check-pi-desktop-install.mjs": [
    { fn: "<module>", line: 'for (const name of ["git", "gh", "npm"]) writeFileSync(join(bin, name), shim, { mode: 0o755 });', why: "writes a fake gh for the install check" },
    { fn: "<module>", line: 'PATH: `${bin}:${process.env.PATH}`, MISSION_NPM_BIN: join(bin, "npm"), MISSION_GH_BIN: join(bin, "gh"),', why: "points the install check at that fake" },
  ],
};

// ---- the scanner ----

/** Calls whose first argument is the program they run. A `gh` binary there is a call site. */
const RUNNERS = new Set([
  "run",
  "runner",
  "runCommand",
  "capture",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);

/** Calls that turn a binary name into the binary itself: transparent to the scan. */
const LOOKUPS = new Set(["locateExecutable", "locateExecutableSync", "resolveBinPath", "present"]);

/** A program named by literal that runs its `-c` argument as a shell command line. */
const SHELLS = /^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh|dash)$/;

/** A `gh` command inside a shell command line. */
const GH_COMMAND_RE = /(?:^|[\s;&|(`])gh\s/;

interface Site {
  file: string;
  fn: string;
  line: number;
  /** The argv expression, or null when the scanner could not follow the binary to a call. */
  argv: string | null;
  /** The trimmed source line, for a site the scanner could not read. */
  text: string;
}

/**
 * A function that runs `gh` with an argv it was handed, so its callers are the call sites. A
 * method is called through a property (`this.gh(...)`), a function by its name.
 */
interface Wrapper {
  name: string;
  method: boolean;
}

function codeFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...codeFiles(path));
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) files.push(path);
  }
  return files;
}

function shellFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...shellFiles(path));
    else if (entry.name.endsWith(".sh")) files.push(path);
  }
  return files;
}

/** One line of argv text, so a reflowed array is the same row. */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([[(]) /g, "$1")
    .replace(/,? ([\])])/g, "$1");
}

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : /\.[cm]?js$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function enclosingName(node: ts.Node): string {
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      const owner = ts.isMethodDeclaration(n) && ts.isClassLike(n.parent) && n.parent.name
        ? `${n.parent.name.text}.`
        : "";
      return `${owner}${n.name.getText()}`;
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
      if (ts.isPropertyAssignment(n.parent) || ts.isPropertyDeclaration(n.parent)) return n.parent.name.getText();
    }
  }
  return "<module>";
}

/** The function `name` is a parameter of, when `node` sits inside it. */
function parameterOwner(node: ts.Node, name: string): ts.SignatureDeclaration | null {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) {
      return n;
    }
  }
  return null;
}

/** How callers reach `fn`, or null when it is anonymous and nothing can call it by name. */
function wrapperOf(fn: ts.SignatureDeclaration): Wrapper | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return { name: fn.name.text, method: false };
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return { name: fn.name.text, method: true };
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const parent = fn.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return { name: parent.name.text, method: false };
    if ((ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) && ts.isIdentifier(parent.name)) {
      return { name: parent.name.text, method: true };
    }
  }
  return null;
}

function isDeclarationName(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === id)
    || (ts.isFunctionDeclaration(parent) && parent.name === id)
    || (ts.isParameter(parent) && parent.name === id)
    || (ts.isPropertyAccessExpression(parent) && parent.name === id)
    || (ts.isPropertyAssignment(parent) && parent.name === id)
    || (ts.isPropertyDeclaration(parent) && parent.name === id)
    || (ts.isMethodDeclaration(parent) && parent.name === id)
    || (ts.isMethodSignature(parent) && parent.name === id)
    || (ts.isPropertySignature(parent) && parent.name === id)
    || ts.isImportSpecifier(parent)
    || ts.isExportSpecifier(parent)
    || ts.isImportClause(parent)
  );
}

function identifiersIn(scope: ts.Node, name: string): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === name && !isDeclarationName(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return found;
}

function propertyReadsIn(scope: ts.Node, name: string): ts.PropertyAccessExpression[] {
  const found: ts.PropertyAccessExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return found;
}

/** Walk up through what does not change which program runs. */
function climb(node: ts.Node, throughProperty: boolean): ts.Node {
  for (;;) {
    const parent = node.parent;
    if (
      ts.isParenthesizedExpression(parent)
      || ts.isAwaitExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isAsExpression(parent)
      || (ts.isBinaryExpression(parent)
        && (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
      || (ts.isCallExpression(parent) && parent.expression !== node && LOOKUPS.has(calleeName(parent) ?? ""))
      || (throughProperty && ts.isPropertyAccessExpression(parent) && parent.expression === node)
    ) {
      node = parent;
      continue;
    }
    return node;
  }
}

/**
 * A read of a bound `gh` binary that only TESTS it - `!exe`, `if (exe)`, `typeof exe`,
 * `status.state !== "satisfied"` - and so cannot hand it to anything that runs it.
 */
function passive(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) {
    return [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(parent.operatorToken.kind);
  }
  return (
    (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
    || (ts.isIfStatement(parent) && parent.expression === node)
    || (ts.isConditionalExpression(parent) && parent.condition === node)
    || ts.isTypeOfExpression(parent)
  );
}

/** The local names `node:child_process`'s shell-string runners (`exec`, `execSync`) go by. */
function shellRunnerNames(tree: ts.SourceFile): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const isChildProcess = (text: string): boolean => text === "child_process" || text === "node:child_process";
  function bindFrom(pattern: ts.BindingName): void {
    if (ts.isIdentifier(pattern)) namespaces.add(pattern.text);
    else if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        const imported = element.propertyName?.getText() ?? element.name.getText();
        if ((imported === "exec" || imported === "execSync") && ts.isIdentifier(element.name)) names.add(element.name.text);
      }
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isChildProcess(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else if (bindings) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "exec" || imported === "execSync") names.add(element.name.text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require"
      && node.initializer.arguments[0] && ts.isStringLiteral(node.initializer.arguments[0])
      && isChildProcess(node.initializer.arguments[0].text)
    ) {
      bindFrom(node.name);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { names, namespaces };
}

/**
 * Every `gh` invocation in one file, as the inventory names it.
 *
 * It starts from the ways a `gh` program appears - a `"gh"` literal, a `ghBin()` call, a call
 * to a wrapper that passes its argv straight through (`runGh`), and a `gh` command inside a
 * shell command line - and follows each to the call that runs it: as a runner's first argument,
 * through a `const` binding and any rebinding of it, through an executable lookup, and from a
 * pass-through wrapper (a function or a method) to each of its callers in any file.
 *
 * Every reference it follows ends in one of three places: a runner call (a site), a pure test
 * of the binary (`!exe`, `status.state !== "x"`), or `argv: null` - which no call row matches,
 * so a shape it cannot follow fails until a person reads it and either declares it a mention or
 * rewrites it into one this reads. A shell command line it cannot read as text fails the same
 * way. The boundary: a program reached only through something this never sees as `gh` - a
 * shell whose name is not a literal, or a value computed in another file and imported - is out
 * of a syntax scan's reach, as it is for `test/executable-contracts.test.ts`.
 */
function ghSites(file: string, source: string, wrappers: readonly Wrapper[] = []): { sites: Site[]; wrappers: Wrapper[] } {
  const tree = parse(file, source);
  const sites: Site[] = [];
  const found: Wrapper[] = [];
  const seen = new Set<ts.Node>();
  const shellRunners = shellRunnerNames(tree);

  function lineOf(node: ts.Node): number {
    return tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  }
  function unread(node: ts.Node): void {
    const line = lineOf(node);
    if (sites.some((s) => s.argv === null && s.line === line)) return;
    sites.push({ file, fn: enclosingName(node), line, argv: null, text: source.split("\n")[line - 1]!.trim() });
  }
  function site(node: ts.Node, argv: string): void {
    sites.push({ file, fn: enclosingName(node), line: lineOf(node), argv, text: "" });
  }
  function call(runnerCall: ts.CallExpression): void {
    if (seen.has(runnerCall)) return;
    seen.add(runnerCall);
    const argv = runnerCall.arguments[1];
    if (!argv || ts.isSpreadElement(argv)) return unread(runnerCall);
    if (ts.isIdentifier(argv)) {
      const owner = parameterOwner(runnerCall, argv.text);
      if (owner) {
        const wrapper = wrapperOf(owner);
        if (!wrapper) return unread(runnerCall);
        found.push(wrapper);
        return;
      }
    }
    site(runnerCall, normalize(argv.getText(tree)));
  }
  function runnerArgument(node: ts.Node): ts.CallExpression | null {
    const parent = node.parent;
    return ts.isCallExpression(parent) && parent.arguments[0] === node && RUNNERS.has(calleeName(parent) ?? "")
      ? parent
      : null;
  }
  function scopeOf(declaration: ts.Node): ts.Node {
    for (let n = declaration.parent; n; n = n.parent) {
      if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) return n;
    }
    return tree;
  }

  // Where a `gh` binary (or a read of a binding holding one) ends up: run, rebound, or unread.
  function place(node: ts.Node, throughProperty: boolean): void {
    const at = climb(node, throughProperty);
    const runner = runnerArgument(at);
    if (runner) return call(runner);
    if (throughProperty && passive(at)) return;
    const parent = at.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === at && ts.isIdentifier(parent.name)) {
      for (const ref of identifiersIn(scopeOf(parent), parent.name.text)) place(ref, true);
      return;
    }
    unread(at);
  }

  function followWrapper(wrapper: Wrapper): void {
    if (wrapper.method) {
      for (const read of propertyReadsIn(tree, wrapper.name)) {
        if (ts.isCallExpression(read.parent) && read.parent.expression === read) recordCall(read.parent);
        else unread(read);
      }
      return;
    }
    for (const ref of identifiersIn(tree, wrapper.name)) {
      const parent = ref.parent;
      if (ts.isCallExpression(parent) && parent.expression === ref) {
        recordCall(parent);
        continue;
      }
      // Handed to a function in this file: its parameter is the wrapper there.
      if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)) {
        const index = parent.arguments.indexOf(ref as ts.Expression);
        const target = functionDeclaration(parent.expression.text);
        const param = target?.parameters[index]?.name;
        if (target?.body && param && ts.isIdentifier(param)) {
          for (const use of identifiersIn(target.body, param.text)) {
            if (ts.isCallExpression(use.parent) && use.parent.expression === use) recordCall(use.parent);
            else unread(use);
          }
          continue;
        }
      }
      unread(ref);
    }
  }
  function recordCall(wrapperCall: ts.CallExpression): void {
    const argv = wrapperCall.arguments[0];
    if (!argv || ts.isSpreadElement(argv)) return unread(wrapperCall);
    site(wrapperCall, normalize(argv.getText(tree)));
  }
  function functionDeclaration(name: string): ts.FunctionDeclaration | null {
    let match: ts.FunctionDeclaration | null = null;
    tree.forEachChild(function visit(node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) match = node;
      else if (!match) ts.forEachChild(node, visit);
    });
    return match;
  }

  // A shell command line: a `gh` command in its text is a site; text it cannot see is unread.
  function commandLine(command: ts.Expression | undefined, at: ts.Node): void {
    if (!command) return unread(at);
    const text = ts.isStringLiteral(command) || ts.isNoSubstitutionTemplateLiteral(command)
      ? command.text
      : ts.isTemplateExpression(command)
        ? command.getText(tree).slice(1, -1)
        : null;
    if (text === null) return unread(command);
    if (GH_COMMAND_RE.test(text)) site(command, normalize(text));
  }
  function shellCall(node: ts.CallExpression): void {
    const callee = node.expression;
    const viaShellRunner = (ts.isIdentifier(callee) && shellRunners.names.has(callee.text))
      || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && shellRunners.namespaces.has(callee.expression.text)
        && (callee.name.text === "exec" || callee.name.text === "execSync"));
    if (viaShellRunner) return commandLine(node.arguments[0], node);
    const program = node.arguments[0];
    const argv = node.arguments[1];
    if (program && (ts.isStringLiteral(program) || ts.isNoSubstitutionTemplateLiteral(program)) && SHELLS.test(program.text)) {
      if (!argv) return;
      if (!ts.isArrayLiteralExpression(argv)) return unread(node);
      const flag = argv.elements.findIndex((e) => ts.isStringLiteral(e) && /^-[a-z]*c$/.test(e.text));
      if (flag !== -1) commandLine(argv.elements[flag + 1], node);
      return;
    }
    // `shell: true` hands the program and its arguments to a shell as one line.
    const options = node.arguments.find(ts.isObjectLiteralExpression);
    const shell = options?.properties.find((p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === "shell");
    if (!shell || (ts.isPropertyAssignment(shell) && shell.initializer.kind === ts.SyntaxKind.FalseKeyword)) return;
    if (program && !(ts.isCallExpression(program) && calleeName(program) === "ghBin")) commandLine(program, node);
  }

  function visit(node: ts.Node): void {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === "gh") {
      if (!ts.isImportDeclaration(node.parent) && !ts.isLiteralTypeNode(node.parent)) place(node, false);
    } else if (ts.isCallExpression(node)) {
      if (calleeName(node) === "ghBin") place(node, false);
      shellCall(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);

  // Pass-through wrappers, this file's and every other file's: a caller is a site wherever it is.
  for (const wrapper of [...found, ...wrappers.filter((w) => !found.some((f) => f.name === w.name && f.method === w.method))]) {
    followWrapper(wrapper);
  }

  return { sites, wrappers: found };
}

/** `gh` commands in a shell script: one site per command, its text up to `;`, `|`, `)` or `&`. */
function shellSites(file: string, source: string): Site[] {
  const sites: Site[] = [];
  source.split("\n").forEach((raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, "");
    for (const match of line.matchAll(/(?:^|[\s;&|(!`])gh\s+/g)) {
      const start = match.index + match[0].indexOf("gh");
      let end = start;
      let quote: string | null = null;
      for (; end < line.length; end++) {
        const c = line[end]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (";|)&".includes(c)) break;
      }
      sites.push({ file, fn: "<shell>", line: index + 1, argv: line.slice(start, end).trim(), text: "" });
    }
  });
  return sites;
}

function repositorySites(): Site[] {
  const files = [...codeFiles(join(ROOT, "src")), ...codeFiles(join(ROOT, "scripts"))];
  const sources = files.map((path) => ({ file: relative(ROOT, path), source: readFileSync(path, "utf8") }));
  const wrappers = sources.flatMap(({ file, source }) => ghSites(file, source).wrappers);
  return [
    ...sources.flatMap(({ file, source }) => ghSites(file, source, wrappers).sites),
    ...shellFiles(join(ROOT, "scripts")).flatMap((path) =>
      shellSites(relative(ROOT, path), readFileSync(path, "utf8"))),
  ];
}

/** What is wrong with `sites` against the inventory: unclassified, unreadable, stale or misfiled. */
function inventoryProblems(
  sites: readonly Site[],
  calls: Readonly<Record<string, readonly GhCall[]>>,
  mentions: Readonly<Record<string, readonly GhMention[]>>,
): string[] {
  const problems: string[] = [];
  const callRows = Object.entries(calls).flatMap(([file, rows]) => rows.map((row) => ({ file, row, used: false })));
  const mentionRows = Object.entries(mentions).flatMap(([file, rows]) => rows.map((row) => ({ file, row, used: false })));
  for (const site of sites) {
    if (site.argv !== null) {
      const row = callRows.find((r) => !r.used && r.file === site.file && r.row.fn === site.fn && r.row.argv === site.argv);
      if (row) row.used = true;
      else problems.push(`${site.file}:${site.line} unclassified gh call in ${site.fn}: ${site.argv}`);
    } else {
      const row = mentionRows.find((r) => !r.used && r.file === site.file && r.row.fn === site.fn && r.row.line === site.text);
      if (row) row.used = true;
      else problems.push(`${site.file}:${site.line} the scanner cannot read this gh binary in ${site.fn}: ${site.text}`);
    }
  }
  for (const { file, row, used } of callRows) {
    if (!used) problems.push(`${file} ${row.fn}: no gh call reads ${row.argv} any more`);
    const hows = typeof row.how === "string" ? [row.how] : row.how;
    if (hows.includes("none") && !NO_REPOSITORY_ARGV.has(row.argv)) {
      problems.push(`${file} ${row.fn}: ${row.argv} names no repository and is not auth status, --version or api user`);
    }
    if (hows.includes("node-id") && !NODE_ID_ARGV.has(row.argv)) {
      problems.push(`${file} ${row.fn}: ${row.argv} is not a reviewed node-id mutation; name its repository`);
    }
    if (!row.why.trim()) problems.push(`${file} ${row.fn}: ${row.argv} needs a reason`);
  }
  for (const { file, row, used } of mentionRows) {
    if (!used) problems.push(`${file} ${row.fn}: no gh mention reads ${row.line} any more`);
    if (!row.why.trim()) problems.push(`${file} ${row.fn}: ${row.line} needs a reason`);
  }
  return problems;
}

test("every gh call in the daemon, app and scripts names how it targets a repository", () => {
  assert.deepEqual(inventoryProblems(repositorySites(), GH_CALLS, GH_MENTIONS), []);
});

test("the scanner follows bindings, lookups and pass-through wrappers to the call", () => {
  const source = [
    'import { execFile } from "node:child_process";',
    "async function runGh(args) {",
    '  const executable = await locateExecutable("gh");',
    "  if (!executable) return null;",
    "  return execFile(executable.path, args);",
    "}",
    "async function latest(run) {",
    '  return run(["release", "list", "--repo", CANONICAL_REPO]);',
    "}",
    "function check() {",
    "  latest(runGh);",
    '  return runGh(["auth", "status"]);',
    "}",
    "function fork(args, repo) {",
    '  const bin = process.env.MISSION_GH_BIN || "gh";',
    '  return execFileSync(bin, [...args, "--repo", repo]);',
    "}",
  ].join("\n");
  const { sites, wrappers } = ghSites("fixture.mjs", source);
  assert.deepEqual(wrappers, [{ name: "runGh", method: false }]);
  assert.deepEqual(
    sites.map(({ fn, argv }) => ({ fn, argv })),
    [
      { fn: "fork", argv: '[...args, "--repo", repo]' },
      { fn: "latest", argv: '["release", "list", "--repo", CANONICAL_REPO]' },
      { fn: "check", argv: '["auth", "status"]' },
    ],
  );
});

test("a bound gh binary read into a call the scanner does not know fails loudly", () => {
  const source = [
    "async function listIssues() {",
    '  const exe = await locateExecutable("gh");',
    "  if (!exe) return null;",
    '  return execFileAsync(exe.path, ["issue", "list"]);',
    "}",
    "function ghPath() {",
    '  const exe = locateExecutableSync("gh");',
    "  return exe.path;",
    "}",
    "async function rebound(cwd) {",
    "  const bin = ghBin();",
    "  const exe = await locateExecutable(bin);",
    '  return execFile(exe.path, ["pr", "list"], { cwd });',
    "}",
  ].join("\n");
  const { sites } = ghSites("src/server/fixture.ts", source);
  assert.deepEqual(inventoryProblems(sites, {}, {}), [
    'src/server/fixture.ts:4 the scanner cannot read this gh binary in listIssues: return execFileAsync(exe.path, ["issue", "list"]);',
    "src/server/fixture.ts:8 the scanner cannot read this gh binary in ghPath: return exe.path;",
    'src/server/fixture.ts:13 unclassified gh call in rebound: ["pr", "list"]',
  ]);
});

test("a pass-through wrapper written as a method makes each of its callers a site", () => {
  const source = [
    "class Issues {",
    "  private gh(args) { return run(ghBin(), args); }",
    "  private runner = (args) => run(ghBin(), args);",
    '  list() { return this.gh(["issue", "list"]); }',
    '  view(url) { return this.runner(["issue", "view", url]); }',
    "  handOff() { return later(this.gh); }",
    "}",
  ].join("\n");
  const { sites, wrappers } = ghSites("src/server/fixture.ts", source);
  assert.deepEqual(wrappers, [{ name: "gh", method: true }, { name: "runner", method: true }]);
  assert.deepEqual(inventoryProblems(sites, {}, {}), [
    'src/server/fixture.ts:4 unclassified gh call in Issues.list: ["issue", "list"]',
    "src/server/fixture.ts:6 the scanner cannot read this gh binary in Issues.handOff: handOff() { return later(this.gh); }",
    'src/server/fixture.ts:5 unclassified gh call in Issues.view: ["issue", "view", url]',
  ]);
});

test("a gh command handed to a shell is a site, and a command line the scanner cannot see fails", () => {
  const source = [
    'import { exec, execSync as sh } from "node:child_process";',
    'import * as cp from "node:child_process";',
    "function shellCalls(cmd, n) {",
    '  sh("gh issue list --json number");',
    "  exec(`gh issue view ${n}`);",
    '  cp.execSync("git status");',
    "  exec(cmd);",
    '  spawn("bash", ["-lc", "gh pr checks --watch"]);',
    '  spawn("sh", ["-c", cmd]);',
    '  run("gh pr list", [], { shell: true });',
    "  run(cmd, [], { shell: true });",
    "}",
  ].join("\n");
  const { sites } = ghSites("scripts/fixture.mjs", source);
  assert.deepEqual(inventoryProblems(sites, {}, {}), [
    "scripts/fixture.mjs:4 unclassified gh call in shellCalls: gh issue list --json number",
    "scripts/fixture.mjs:5 unclassified gh call in shellCalls: gh issue view ${n}",
    "scripts/fixture.mjs:7 the scanner cannot read this gh binary in shellCalls: exec(cmd);",
    "scripts/fixture.mjs:8 unclassified gh call in shellCalls: gh pr checks --watch",
    'scripts/fixture.mjs:9 the scanner cannot read this gh binary in shellCalls: spawn("sh", ["-c", cmd]);',
    'scripts/fixture.mjs:10 unclassified gh call in shellCalls: gh pr list',
    "scripts/fixture.mjs:11 the scanner cannot read this gh binary in shellCalls: run(cmd, [], { shell: true });",
  ]);
});

test("an unclassified gh call fails the inventory", () => {
  const source = [
    'import { ghBin } from "./config.ts";',
    "async function listIssues(cwd) {",
    '  return run(ghBin(), ["issue", "list", "--json", "number"], { cwd });',
    "}",
  ].join("\n");
  const { sites } = ghSites("src/server/fixture.ts", source);
  assert.deepEqual(inventoryProblems(sites, {}, {}), [
    'src/server/fixture.ts:3 unclassified gh call in listIssues: ["issue", "list", "--json", "number"]',
  ]);
});

test("a call that names no repository cannot be classified as none", () => {
  const source = 'async function listIssues() { return run(ghBin(), ["issue", "list"]); }';
  const { sites } = ghSites("src/server/fixture.ts", source);
  const calls = { "src/server/fixture.ts": [{ fn: "listIssues", argv: '["issue", "list"]', how: "none" as const, why: "nothing" }] };
  assert.deepEqual(inventoryProblems(sites, calls, {}), [
    'src/server/fixture.ts listIssues: ["issue", "list"] names no repository and is not auth status, --version or api user',
  ]);
});

test("a gh binary the scanner cannot follow fails loudly rather than passing", () => {
  const source = [
    "function listIssues() {",
    '  const argv = [ghBin(), "issue", "list"];',
    "  return spawn(argv[0], argv.slice(1));",
    "}",
    "function viaSpread(args) {",
    "  return run(ghBin(), ...args);",
    "}",
  ].join("\n");
  const { sites } = ghSites("src/server/fixture.ts", source);
  assert.deepEqual(inventoryProblems(sites, {}, {}), [
    'src/server/fixture.ts:2 the scanner cannot read this gh binary in listIssues: const argv = [ghBin(), "issue", "list"];',
    "src/server/fixture.ts:6 the scanner cannot read this gh binary in viaSpread: return run(ghBin(), ...args);",
  ]);
});

test("a node-id row is limited to the reviewed mutation", () => {
  const source = 'async function close(id) { return run(ghBin(), ["api", "graphql", "-F", `id=${id}`]); }';
  const { sites } = ghSites("src/server/fixture.ts", source);
  const calls = { "src/server/fixture.ts": [{ fn: "close", argv: '["api", "graphql", "-F", `id=${id}`]', how: "node-id" as const, why: "an id" }] };
  assert.deepEqual(inventoryProblems(sites, calls, {}), [
    'src/server/fixture.ts close: ["api", "graphql", "-F", `id=${id}`] is not a reviewed node-id mutation; name its repository',
  ]);
});

test("a row no call reads any more fails, so the inventory cannot outlive its calls", () => {
  const calls = { "src/server/gone.ts": [{ fn: "gone", argv: '["issue", "list"]', how: "resolver" as const, why: "removed" }] };
  assert.deepEqual(inventoryProblems([], calls, {}), ['src/server/gone.ts gone: no gh call reads ["issue", "list"] any more']);
});

// ---- part 2: agent instructions ----

/**
 * Agent-facing TypeScript: only its string and template text is read, never its comments,
 * which explain these commands to the next maintainer rather than giving them to an agent.
 */
const AGENT_TEXT_SOURCES = [
  "src/shared/queue.ts",
  "src/server/task-contract.ts",
  "src/server/workflows/feedback.ts",
  "src/server/foreman/review-followup.ts",
];

/**
 * Shipped action text is snapshotted by built-in workflow versions and pinned by digest in
 * `test/builtin-workflows.test.ts`, so it cannot change here; it defers to the pull-request skill.
 */
const FROZEN_AGENT_TEXT = new Set(["actions/pull-request.md"]);

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

/** Every string a TypeScript source can hand an agent, with `+` chains joined into one. */
function agentStrings(file: string, source: string): string[] {
  const tree = parse(file, source);
  const texts: string[] = [];
  function piece(node: ts.Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans
        .map((span) => `\${${span.expression.getText(tree)}}${span.literal.text}`)
        .join("");
    }
    return null;
  }
  function operands(node: ts.Expression): ts.Expression[] {
    return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ? [...operands(node.left), ...operands(node.right)]
      : [node];
  }
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const parts = operands(node);
      if (parts.some((part) => piece(part) !== null)) {
        texts.push(parts.map((part) => piece(part) ?? `\${${part.getText(tree)}}`).join(""));
        for (const part of parts) {
          if (ts.isTemplateExpression(part)) part.templateSpans.forEach((span) => visit(span.expression));
          else if (piece(part) === null) visit(part);
        }
        return;
      }
    }
    const text = piece(node);
    if (text !== null) {
      texts.push(text);
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((span) => visit(span.expression));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return texts;
}

/** A pull request or issue named by URL: literal, `<...url>` placeholder, or a `$...url` variable. */
const URL_TARGET_RE = /^["'(]?(?:https:\/\/github\.com\/|<[\w-]*url>|\$\{?[\w.]*url[\w.]*\}?)/i;
const BY_NUMBER_RE = /(?:^|[\s;&|(`])gh\s+(?:issue|pr)\s+(?:view|checks|comment|edit|close|reopen|merge|diff|review)\b((?:\s+--?[\w-]+(?=\s|$|`))*)(\s+[^\s`]+)?/g;
const PLACEHOLDER_RE = /(?<!\$)\{(?:owner|repo)\}/g;
const ORIGIN_READ_RE = /git\s+remote\s+get-url\s+origin|remote\.origin\.url/g;

/** Where `text` lets gh choose the repository, one line per refusal. */
function agentTextProblems(where: string, text: string): string[] {
  const problems: string[] = [];
  const at = (index: number): string => `${where}:${text.slice(0, index).split("\n").length}`;
  const pr = new RegExp(PR_CREATE_RE.source, "g");
  for (const match of text.matchAll(pr)) {
    problems.push(`${at(match.index)} gives \`gh pr create\`, which always reads the fork's parent; give openPullRequestCommand`);
  }
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    problems.push(`${at(match.index)} uses gh's ${match[0]} placeholder; read $repo from origin with originRepositoryShell`);
  }
  for (const match of text.matchAll(BY_NUMBER_RE)) {
    const target = match[2]?.trim() ?? "";
    if (!URL_TARGET_RE.test(target)) {
      problems.push(`${at(match.index)} names ${target ? `"${target}"` : "no pull request or issue"} in "${match[0].trim()}"; name it by URL`);
    }
  }
  // Every read of origin is the exported line, character for character.
  const copies: [number, number][] = [];
  for (let i = text.indexOf(originRepositoryShell); i !== -1; i = text.indexOf(originRepositoryShell, i + 1)) {
    copies.push([i, i + originRepositoryShell.length]);
  }
  for (const match of text.matchAll(ORIGIN_READ_RE)) {
    if (!copies.some(([start, end]) => match.index >= start && match.index < end)) {
      problems.push(`${at(match.index)} reads origin with a line that is not originRepositoryShell`);
    }
  }
  return problems;
}

function agentTexts(): { where: string; text: string }[] {
  const markdown = [...markdownFiles(join(ROOT, "skills")), ...markdownFiles(join(ROOT, "actions"))]
    .map((path) => relative(ROOT, path))
    .filter((file) => !FROZEN_AGENT_TEXT.has(file))
    .map((file) => ({ where: file, text: readFileSync(join(ROOT, file), "utf8") }));
  const code = AGENT_TEXT_SOURCES.flatMap((file) =>
    agentStrings(file, readFileSync(join(ROOT, file), "utf8")).map((text) => ({ where: file, text })));
  return [...markdown, ...code];
}

test("agent instructions name their repository and never leave it to gh", () => {
  const texts = agentTexts();
  // The scan reads what it claims to: every skill, and the wrap-up's own command.
  assert.ok(texts.some(({ where }) => where === "skills/pull-request/SKILL.md"));
  assert.ok(texts.some(({ where, text }) => where === "src/shared/queue.ts" && text.includes("gh pr checks <pr-url>")));
  assert.deepEqual(texts.flatMap(({ where, text }) => agentTextProblems(where, text)), []);
});

test("the frozen pull-request action is exempt, not clean", () => {
  // If this stops failing the scan, the exemption is dead weight and should go.
  const text = readFileSync(join(ROOT, "actions/pull-request.md"), "utf8");
  assert.notDeepEqual(agentTextProblems("actions/pull-request.md", text), []);
});

test("agent text that leaves the repository to gh is refused", () => {
  assert.deepEqual(agentTextProblems("fixture.md", "Read it: `gh issue view 12 --comments`."), [
    'fixture.md:1 names "12" in "`gh issue view 12"; name it by URL',
  ]);
  assert.deepEqual(agentTextProblems("fixture.md", "Then\nrun `gh pr checks --watch`."), [
    'fixture.md:2 names no pull request or issue in "`gh pr checks --watch"; name it by URL',
  ]);
  assert.deepEqual(agentTextProblems("fixture.md", "`gh api repos/{owner}/{repo}/branches`"), [
    "fixture.md:1 uses gh's {owner} placeholder; read $repo from origin with originRepositoryShell",
    "fixture.md:1 uses gh's {repo} placeholder; read $repo from origin with originRepositoryShell",
  ]);
  assert.deepEqual(agentTextProblems("fixture.md", "Open it with `gh pr create --fill`."), [
    "fixture.md:1 gives `gh pr create`, which always reads the fork's parent; give openPullRequestCommand",
  ]);
  // The names are fine: by URL in every form the instructions use, and `${repo}` is a shell variable.
  for (const ok of [
    "`gh issue view <issue-url> --comments`",
    "`gh pr checks <pr-url> --watch`",
    "`gh pr view https://github.com/me/fork/pull/3`",
    'gh pr comment "$PR_URL" --body-file x',
    "`gh pr view ${pr.url} --comments`",
    '`gh api "repos/${repo}/pulls"`',
    "never with `gh pr create`.",
  ]) {
    assert.deepEqual(agentTextProblems("fixture.md", ok), [], ok);
  }
});

test("a drifted origin-reading line is refused", () => {
  assert.deepEqual(agentTextProblems("fixture.md", `\`${originRepositoryShell}\``), []);
  const drifted = "`repo=$(git remote get-url origin | sed -E 's#^.*github.com[:/]##; s#.git$##')`";
  assert.deepEqual(agentTextProblems("fixture.md", drifted), [
    "fixture.md:1 reads origin with a line that is not originRepositoryShell",
  ]);
  assert.deepEqual(agentTextProblems("fixture.md", "`git config --get remote.origin.url`"), [
    "fixture.md:1 reads origin with a line that is not originRepositoryShell",
  ]);
});

test("TypeScript agent text is read through concatenation and templates, not comments", () => {
  const source = [
    "// `gh issue view 12` in a comment is for maintainers",
    'export const A = "Read `gh pr" + " view 12`, then " + `gh pr checks ${url} --watch`;',
  ].join("\n");
  const texts = agentStrings("fixture.ts", source);
  assert.deepEqual(texts, ["Read `gh pr view 12`, then gh pr checks ${url} --watch"]);
  assert.deepEqual(texts.flatMap((text) => agentTextProblems("fixture.ts", text)), [
    'fixture.ts:1 names "12" in "`gh pr view 12"; name it by URL',
  ]);
});
