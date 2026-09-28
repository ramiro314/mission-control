import {
  FLAKY_TESTS_CHECK_NAME,
  FlakeReportSchema,
  flakeSummaryTitle,
  renderFlakeSummary,
  type FlakeReport,
} from "@shared/flake-report.ts";
import { parseTestingConfig, type TestingConfig } from "@shared/testing-config.ts";
import type { RunContext } from "./context.ts";
import { GitHubError, type GitHubClient } from "./github.ts";
import { updateFlakeIssues } from "./issues.ts";
import { emptyReport } from "./rerun.ts";

// `mode: publish`, one job after every test job: merge the per-job reports, record the flakes
// on their history issues, and publish the "Flaky tests" check on the commit the tests ran
// against. Without write permission (a fork PR) it still produces the merged report and the
// job summary, and says which writes it skipped.

export interface PerJobReport {
  /** Where it came from, for messages. */
  source: string;
  text: string;
}

/** Merge per-job reports into one; unreadable ones become errors rather than silence. */
export function mergeReports(ctx: RunContext, inputs: readonly PerJobReport[]): FlakeReport {
  const merged = emptyReport(ctx);
  for (const input of inputs) {
    let raw: unknown;
    try {
      raw = JSON.parse(input.text);
    } catch {
      merged.errors.push(`The report ${input.source} is not valid JSON.`);
      continue;
    }
    const parsed = FlakeReportSchema.safeParse(raw);
    if (!parsed.success) {
      merged.errors.push(`The report ${input.source} is not a v1 flake report.`);
      continue;
    }
    merged.flakes.push(...parsed.data.flakes);
    merged.failures.push(...parsed.data.failures);
    merged.errors.push(...parsed.data.errors);
  }
  return merged;
}

export interface PublishOptions {
  ctx: RunContext;
  reports: readonly PerJobReport[];
  /** The committed `.mission/testing.json` text, or null when the repository has none. */
  configText: string | null;
  client: GitHubClient;
  now: Date;
}

export interface PublishResult {
  report: FlakeReport;
  summary: string;
  /** What the action did not do, and why; shown in the job summary. */
  notes: string[];
  conclusion: "success" | "neutral";
}

function flakesConfig(configText: string | null): { flakes: TestingConfig["flakes"] } | { error: string } {
  const parsed = parseTestingConfig(configText ?? "{}");
  return parsed.ok ? { flakes: parsed.config.flakes } : { error: parsed.error };
}

export async function publish(opts: PublishOptions): Promise<PublishResult> {
  const { ctx, client, now } = opts;
  const notes: string[] = [];
  const merged = mergeReports(ctx, opts.reports);
  notes.push(`Read ${opts.reports.length} per-job report${opts.reports.length === 1 ? "" : "s"}.`);

  if (ctx.readOnlyReason) {
    notes.push(`Skipped updating flake issues and publishing the "${FLAKY_TESTS_CHECK_NAME}" check: ${ctx.readOnlyReason}.`);
  } else {
    // Runs with no flakes too: closed issues still lose the actionable label.
    const config = flakesConfig(opts.configText);
    if ("error" in config) {
      notes.push(`Skipped updating flake issues: ${config.error}`);
    } else {
      try {
        merged.issues = await updateFlakeIssues({ client, ctx, flakes: config.flakes, report: merged, now });
      } catch (err) {
        if (!(err instanceof GitHubError && err.forbidden)) throw err;
        notes.push("Skipped updating flake issues: the token cannot write issues (grant `issues: write`).");
      }
    }
  }

  const summary = renderFlakeSummary(merged);
  const conclusion = merged.flakes.length > 0 ? "neutral" : "success";
  if (!ctx.readOnlyReason) {
    try {
      await client.request("POST", `/repos/${ctx.repository}/check-runs`, {
        name: FLAKY_TESTS_CHECK_NAME,
        head_sha: ctx.commit,
        status: "completed",
        conclusion,
        completed_at: now.toISOString(),
        details_url: ctx.runUrl,
        output: { title: flakeSummaryTitle(merged), summary },
      });
    } catch (err) {
      if (!(err instanceof GitHubError && err.forbidden)) throw err;
      notes.push(`Skipped publishing the "${FLAKY_TESTS_CHECK_NAME}" check: the token cannot write checks (grant \`checks: write\`).`);
    }
  }
  return { report: merged, summary, notes, conclusion };
}
