export const DEFAULT_REPO: string;
export const FEATURE_LABEL: string;
export const CLOSING_MARKER: string;
export const TEMPLATE_SECTIONS: readonly string[];
export const LABEL_WARN_LENGTH: number;

export type LedgerEntry = {
  name: string;
  slug: string;
  status: "active" | "in-progress" | "superseded" | "removed" | "upstreamed";
  statusText: string;
  sections: { name: string; text: string }[];
  entryPrs: number[];
};
export type GlanceRow = { name: string; prs: number[]; skipped: string[] };
export type Ledger = { entries: LedgerEntry[]; glance: GlanceRow[] };

export type DesiredIssue = {
  slug: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  closingComment: string | null;
};
export type Desired = {
  labels: { name: string; color: string; description: string }[];
  issues: DesiredIssue[];
  prs: Map<number, string[]>;
  notes: string[];
};

export type ActualIssue = { number: number; title: string; state: string; labels: string[]; body: string; comments: string[] };
export type Actual = { labels: string[]; issues: ActualIssue[]; prs: Map<number, string[]> };

export type SectionChange = { name: string; current: string | null; next: string | null };
export type Write =
  | { op: "create-label"; name: string; color: string; description: string }
  | { op: "create-issue"; slug: string; title: string; body: string; labels: string[] }
  | {
      op: "edit-issue";
      slug: string;
      number: number;
      title: string | null;
      body: string | null;
      sections: SectionChange[];
      addLabels: string[];
      removeLabels: string[];
    }
  | { op: "comment-issue"; slug: string; number: number | null; body: string }
  | { op: "close-issue" | "reopen-issue"; slug: string; number: number | null }
  | { op: "label-pr"; number: number; addLabels: string[] };

export type Run = (args: string[], input?: string) => string;

export function slugFor(name: string): string;
export function parsePrCell(cell: string): { prs: number[]; skipped: string[] };
export function unwrap(text: string): string;
export function absoluteLinks(text: string, repo: string): string;
export function parseLedger(text: string, options?: { repo?: string }): Ledger;
export function desiredState(ledger: Ledger): Desired;
export function formatPlan(desired: Desired): string;
export function planWrites(desired: Desired, actual: Actual): { writes: Write[]; warnings: string[] };
export function formatWrite(write: Write, number?: number | null): string;
export function ghRunner(repo: string): Run;
export function fetchState(run: Run): Actual;
export function executeWrites(writes: readonly Write[], run: Run, print: (text: string) => void): void;
