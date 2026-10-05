/**
 * Reads `.github/workflows/ci.yml` as text. The repository has no YAML parser, so the CI
 * contract tests read the workflow the way `test/oss-readiness.test.ts` does.
 */
import assert from "node:assert/strict";

/** Each top-level job's id and its body, the lines up to the next job id. */
export function jobs(workflow: string): Map<string, string> {
  const lines = workflow.split("\n");
  const start = lines.indexOf("jobs:");
  assert.notEqual(start, -1, "ci.yml has a top-level jobs: key");
  const out = new Map<string, string>();
  let id: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const next = line.match(/^ {2}([\w-]+):\s*$/)?.[1];
    if (next || /^\S/.test(line)) {
      if (id) out.set(id, body.join("\n"));
      id = next ?? null;
      body = [];
      if (!next) break;
    } else {
      body.push(line);
    }
  }
  if (id) out.set(id, body.join("\n"));
  return out;
}

/** `needs:` as a flow list (`[a, b]`), a block list, or a single id. */
export function needs(body: string): string[] {
  const inline = body.match(/^ {4}needs:[ \t]*(\S.*?)[ \t]*$/m)?.[1];
  if (inline) return inline.replace(/^\[|\]$/g, "").split(",").map((id) => id.trim());
  const block = body.match(/^ {4}needs:[ \t]*\n((?: {6}- .+\n?)+)/m)?.[1] ?? "";
  return [...block.matchAll(/^ {6}- (.+?)\s*$/gm)].map(([, id]) => id!);
}

/**
 * A job on `windows-latest`. The Windows jobs are allowed to fail until M2 is green, so they
 * stay out of `CI result` and carry a docs-only condition of their own;
 * `test/windows-ci.test.ts` holds them.
 */
export function isWindowsJob(body: string): boolean {
  return /^ {4}runs-on: windows-latest$/m.test(body);
}
