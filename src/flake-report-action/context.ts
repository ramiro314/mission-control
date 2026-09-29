// What the GitHub Actions environment says about this run, read once.

export interface RunContext {
  /** `owner/name`. */
  repository: string;
  apiUrl: string;
  /** The commit the tests ran against: the PR head for a pull request, never its merge commit. */
  commit: string;
  ref: string;
  pullRequest: number | null;
  runUrl: string;
  /** Why this run's token cannot write checks or issues, or null when it should be able to. */
  readOnlyReason: string | null;
}

interface PullRequestEvent {
  pull_request?: {
    number?: number;
    head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
    base?: { repo?: { full_name?: string } };
  };
}

/** Build the context from the Actions environment and the parsed event payload. */
export function runContextFrom(env: Record<string, string | undefined>, event: unknown): RunContext {
  const repository = env.GITHUB_REPOSITORY ?? "";
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const pr = (event as PullRequestEvent | null)?.pull_request;
  const headRepo = pr?.head?.repo?.full_name;
  const baseRepo = pr?.base?.repo?.full_name ?? repository;
  // A pull request from a fork (or one whose head repository was deleted) runs with a
  // read-only token whatever the workflow's permissions block asks for.
  const fromFork = pr !== undefined && headRepo !== baseRepo;
  return {
    repository,
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    commit: pr?.head?.sha ?? env.GITHUB_SHA ?? "",
    // `||`, not `??`: Actions sets GITHUB_HEAD_REF to "" (not unset) outside pull requests.
    ref: pr?.head?.ref || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "",
    pullRequest: typeof pr?.number === "number" ? pr.number : null,
    runUrl: `${server}/${repository}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`,
    readOnlyReason: fromFork ? "this pull request comes from a fork, so its token is read-only" : null,
  };
}
