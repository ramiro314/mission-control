// The few GitHub REST calls the action makes, over the global `fetch` with the job's token.

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`GitHub ${method} ${path} answered ${status}: ${body.slice(0, 300)}`);
  }

  /** The token lacks the permission (a fork PR, or a workflow that did not grant it). */
  get forbidden(): boolean {
    return this.status === 403 || (this.status === 404 && this.method !== "GET");
  }
}

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface GitHubClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** GET every page of a list endpoint (100 per page, at most 50 pages). */
  paginate<T = unknown>(path: string): Promise<T[]>;
}

export function gitHubClient(opts: { apiUrl: string; token: string; fetch: FetchLike }): GitHubClient {
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await opts.fetch(`${opts.apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${opts.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "mission-flake-report",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(res.status, method, path, text);
    return (text ? JSON.parse(text) : null) as T;
  };
  return {
    request,
    async paginate<T>(path: string): Promise<T[]> {
      const all: T[] = [];
      const joiner = path.includes("?") ? "&" : "?";
      for (let page = 1; page <= 50; page++) {
        const items = await request<T[]>("GET", `${path}${joiner}per_page=100&page=${page}`);
        all.push(...items);
        if (items.length < 100) break;
      }
      return all;
    },
  };
}
