export const APPLIED_LABEL: string;
export const STATUSES: readonly string[];

export class ForkDeltaFormatError extends Error {}
export class UsageError extends Error {}
export function exitCodeFor(err: unknown): 2 | 3;

export type Issue = { number: number; state: string; labels: string[]; body: string };
export type MergedPr = { number: number; mergedAt: string | null; labels: string[]; body: string };

export type Block = { name: string; base: string; text: string; status?: string; note?: string };
export type ForkChanges = { none: boolean; features: { slug: string; blocks: Block[] }[] };

export type Section = { name: string; text: string };
export type Feature = {
  slug: string;
  issue: number | null;
  exists: boolean;
  state: "open" | "closed";
  statusLabels: string[];
  preamble: string;
  sections: Section[];
};
export type Features = Map<string, Feature>;

export type StaleBlock = { slug: string; section: string; base: string; current: string };
export type PlanEntry = {
  number: number;
  verdict: "apply" | "stale" | "held" | "invalid";
  features: string[];
  stale: StaleBlock[];
  heldBehind: number[];
  error: string | null;
  missingSection: boolean;
};
export type CheckResult = {
  number: number;
  changes: ForkChanges | null;
  applied: boolean;
  stale: StaleBlock[];
  heldBehind: number[];
  ok: boolean;
};

export function normalizeSection(text: string): string;
export function scanLines(text: string): { line: string; code: boolean }[];
export function sectionHash(text: string): string;
export function parseForkChanges(body: string | null | undefined): ForkChanges | null;
export function parseIssueBody(body: string | null | undefined): { preamble: string; sections: Section[] };
export function renderIssueBody(feature: Feature): string;
export function statusLine(feature: Feature): string;
export function featuresFromIssues(issues: readonly Issue[]): Features;
export function applyChanges(features: Features, changes: ForkChanges): Features;
export function currentBase(features: Features, slug: string, section: string): string;
export function staleBlocks(features: Features, changes: ForkChanges): StaleBlock[];
export function pendingPrs(prs: readonly MergedPr[]): MergedPr[];
export function overlayFor(
  issues: readonly Issue[],
  prs: readonly MergedPr[],
  cutoff?: MergedPr | null,
): { features: Features; skipped: number[] };
export function planRefresh(issues: readonly Issue[], prs: readonly MergedPr[]): { entries: PlanEntry[]; features: Features };
export function checkPr(target: MergedPr, issues: readonly Issue[], prs: readonly MergedPr[]): CheckResult;
export function renderShow(features: Features, slug: string): string;
export function formatCheck(result: CheckResult): { text: string; code: number };
export function formatPlan(entries: readonly PlanEntry[]): string;
