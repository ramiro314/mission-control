export const WINDOWS_SLUG: string;
export const WINDOWS_BRANCH: string;

export type ReportIssue = { number: number; title: string; state: string; labels: string[]; body: string; url: string };
export type ReportPr = {
  number: number;
  title: string;
  labels: string[];
  headRefName: string;
  baseRefName: string;
  mergedAt: string | null;
  url: string;
  author: { login: string } | null;
};
export type ReportData = {
  issues: ReportIssue[];
  prs: ReportPr[];
  windowsPrs: { number: number; mergedAt: string | null }[];
  git: {
    mergeBase: string;
    mergeBaseVersion: string;
    upstreamTip: string;
    ahead: number;
    aheadNoMerges: number;
    behind: number;
  };
  measuredAt: { sha: string; time: string };
};

export function featureStatus(issue: Pick<ReportIssue, "state" | "labels">): string;
export function intentSentence(body: string | null | undefined): string;
export function windowsIncludes(
  prs: readonly Pick<ReportPr, "number" | "headRefName" | "mergedAt">[],
  windowsPrs: ReportData["windowsPrs"],
): Map<number, number>;
export function renderForkReport(data: ReportData): string;
