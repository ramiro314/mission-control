// Which GitHub repository a checkout's `gh` calls target.
//
// Its own pure module because three runtimes ask - the daemon, Electron main and the
// repository's `scripts/` - and each one used to decide for itself, or not at all. Left to
// choose, `gh` picks the base repository from the remotes, and outside a terminal it prefers
// one named `upstream`: on a fork, the parent, which an org enforcing SAML SSO refuses to a
// token not authorized there. So no caller leaves the choice to `gh`; it reads the checkout's
// git config, hands it to `pickCheckoutRepository`, and passes the answer as `--repo`.
//
// Nothing here runs git. The caller does, with `REMOTE_CONFIG_ARGS`, so the daemon can use its
// own subprocess runner and a script can use `execFileSync`.

/** The `git` arguments whose stdout `parseRemoteConfig` reads. Exits 1 when nothing matches. */
export const REMOTE_CONFIG_ARGS = ["config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"];

/** Read a GitHub repository identity from one configured git remote URL, or null. */
export function parseGitHubRemoteUrl(url) {
  const value = url.trim();
  const scp = /^(?:[^@\s]+@)?github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(value);
  if (scp) return { owner: scp[1], repo: scp[2] };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  if (!["git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * The remotes in `git config --get-regexp` output for `REMOTE_CONFIG_ARGS`, in config order.
 *
 * `urls` keeps every `url` entry, because git allows several and the first is the one fetched.
 * `ghResolved` is what `gh repo set-default` wrote (`base`, or an `owner/name`), else null.
 */
export function parseRemoteConfig(stdout) {
  const remotes = new Map();
  for (const line of stdout.split("\n")) {
    const separator = line.search(/\s/);
    if (separator < 0) continue;
    const key = /^remote\.(.+)\.(url|gh-resolved)$/.exec(line.slice(0, separator));
    if (!key) continue;
    const [, name, variable] = key;
    const value = line.slice(separator).trim();
    const remote = remotes.get(name) ?? { name, urls: [], ghResolved: null };
    if (variable === "url") remote.urls.push(value);
    else remote.ghResolved ??= value;
    remotes.set(name, remote);
  }
  return [...remotes.values()];
}

function githubRepositoryOf(remote) {
  const url = remote?.urls[0];
  return url === undefined ? null : parseGitHubRemoteUrl(url);
}

/** The repository a `gh-resolved` pin names, or null when the pin is unset or unusable. */
function pinnedRepository(remote) {
  const own = githubRepositoryOf(remote);
  if (!own || !remote.ghResolved) return null;
  if (remote.ghResolved === "base") return own;
  const named = /^([\w.-]+)\/([\w.-]+)$/.exec(remote.ghResolved);
  return named ? { owner: named[1], repo: named[2] } : null;
}

const slug = ({ owner, repo }) => `${owner}/${repo}`;

/**
 * Which GitHub repository `gh` should be told to use in `checkout`, given its parsed remotes.
 *
 * 1. A gh default pin: the first remote whose `gh-resolved` is `base`, or an `owner/name` gh
 *    stored for a renamed repository. Honoured only when that remote's URL is on GitHub.
 * 2. Otherwise `origin`, when its URL is on GitHub.
 * 3. Otherwise an error that names the checkout and lists its remotes. Never `gh`'s own
 *    choice: that is the implicit fallback that lands on a fork's parent.
 *
 * `source` says where the answer departs from what the operator would expect, not who wrote
 * the pin: a pin naming origin's own repository reports `origin`, and only a pin naming a
 * different repository reports `gh-default`.
 */
export function pickCheckoutRepository(remotes, checkout) {
  const origin = remotes.find((remote) => remote.name === "origin");
  const originRepository = githubRepositoryOf(origin);
  for (const remote of remotes) {
    const pinned = pinnedRepository(remote);
    if (!pinned) continue;
    const sameAsOrigin =
      originRepository !== null && slug(originRepository).toLowerCase() === slug(pinned).toLowerCase();
    return { ok: true, repo: slug(pinned), source: sameAsOrigin ? "origin" : "gh-default" };
  }
  if (originRepository) return { ok: true, repo: slug(originRepository), source: "origin" };

  const listed = remotes.length
    ? remotes.map((remote) => `${remote.name} is ${remote.urls[0] ?? "(no url)"}`).join(", ")
    : "it has no remotes";
  const pin = remotes.some((remote) => remote.ghResolved) ? "the gh default is not a GitHub remote" : "no gh default is set";
  return {
    ok: false,
    error:
      `No GitHub repository for ${checkout}: ${listed}; ${pin}. ` +
      "Point origin at GitHub, or run `gh repo set-default`.",
  };
}
