import { z } from "zod";
import { WorkflowCommandArgvSchema } from "./protocol.ts";
import {
  StoredTestingSettingsSchema,
  storedTestingSettingsKeys,
  testingScopePath,
  type StoredTestingSettings,
} from "./testing-config.ts";
import {
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_LIMITS,
  commandTemplateProblem,
  type WorkflowCheckSlot,
} from "./workflow.ts";

// A Command document: one repository's Command overrides, for every slot, and its stored testing
// settings, as one versioned JSON file an operator can paste, upload, export and import again.
//
// It describes ROWS, never the catalog around them. A document cannot name a slot's global
// default, its run budget, or anything about worktree pools: the top level and every entry are
// strict, so such a key is refused instead of silently ignored. Paths are repository-relative
// (`""` is the root), so a document exported from one checkout reads the same on another.
//
// Applying is a merge. A row the document does not mention is untouched, a listed row is added
// or replaced, and only an explicit `remove` entry removes one. Each entry is held to the rules
// its own catalog already enforces: the affected-tests template rule and duplicate refusal here,
// and the override cap once the document is merged with what is stored (the daemon's preview).
//
// Browser-safe on purpose: the Library validates a pasted document with the same schema before
// it asks the daemon for a preview, and the daemon validates it again.

export const COMMAND_DOCUMENT_VERSION = 1;

/** Bounds on one document, beyond the per-entry rules each catalog already has. */
export const COMMAND_DOCUMENT_LIMITS = {
  /**
   * Entries per slot. Twice the slot's override cap, because a document may remove as many
   * rows as it sets; the cap on what the slot ends up holding is checked after the merge.
   */
  commandEntries: WORKFLOW_LIMITS.commandOverrides * 2,
  /** Testing settings entries, sets and removals together. */
  testingEntries: 400,
} as const;

/** Why a document path cannot name a folder in the repository. */
export const COMMAND_DOCUMENT_PATH_RULE =
  "must be repository-relative with forward slashes, no leading or trailing slash, and no . or .. segments (\"\" is the root)";

const DocumentPathSchema = z
  .string()
  .max(WORKFLOW_LIMITS.checkRepoRoot)
  .refine((path) => testingScopePath(path) !== null, { message: COMMAND_DOCUMENT_PATH_RULE });

/** One Command row: set `argv` at `path`, or remove the row at `path`. Exactly one of the two. */
const CommandEntrySchema = z
  .object({
    path: DocumentPathSchema,
    argv: WorkflowCommandArgvSchema.optional(),
    remove: z.literal(true).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if ((entry.argv === undefined) === (entry.remove === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an entry has either argv or \"remove\": true, not both and not neither" });
    }
  });

/** One testing settings row: store `settings` at `path`, or clear the row at `path`. */
const TestingEntrySchema = z
  .object({
    path: DocumentPathSchema,
    settings: StoredTestingSettingsSchema.optional(),
    remove: z.literal(true).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if ((entry.settings === undefined) === (entry.remove === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an entry has either settings or \"remove\": true, not both and not neither" });
      return;
    }
    // A row that sets no key is not a layer, so storing one would read as a change that changes
    // nothing. Saying `remove` is how a document clears a row.
    if (entry.settings && storedTestingSettingsKeys(entry.settings).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["settings"],
        message: "settings must set at least one tests key; use \"remove\": true to clear a row",
      });
    }
  });

const CommandEntriesSchema = z.array(CommandEntrySchema).max(COMMAND_DOCUMENT_LIMITS.commandEntries).optional();

/** One optional entry list per built-in slot, and no other key. */
const CommandsSchema = z.object({
  test: CommandEntriesSchema,
  lint: CommandEntriesSchema,
  typecheck: CommandEntriesSchema,
  build: CommandEntriesSchema,
  documentation: CommandEntriesSchema,
  "affected-tests": CommandEntriesSchema,
}).strict();
// Every built-in slot has a key above, and nothing else does: a slot added to
// `WORKFLOW_CHECK_SLOTS` fails typecheck here until a document can name it.
type CommandsSlots = keyof z.infer<typeof CommandsSchema>;
const commandsCoverEverySlot: [CommandsSlots] extends [WorkflowCheckSlot]
  ? [WorkflowCheckSlot] extends [CommandsSlots] ? true : never
  : never = true;
void commandsCoverEverySlot;

function duplicatePaths(entries: ReadonlyArray<{ path: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) duplicates.add(entry.path);
    seen.add(entry.path);
  }
  return [...duplicates];
}

/** A repository-relative path as a person reads it. */
export function commandDocumentPathLabel(path: string): string {
  return path === "" ? "the repository root" : path;
}

export const CommandDocumentSchema = z
  .object({
    version: z.literal(COMMAND_DOCUMENT_VERSION),
    commands: CommandsSchema.optional(),
    testing: z.array(TestingEntrySchema).max(COMMAND_DOCUMENT_LIMITS.testingEntries).optional(),
  })
  .strict()
  .superRefine((document, ctx) => {
    for (const slot of WORKFLOW_CHECK_SLOTS) {
      const entries = document.commands?.[slot] ?? [];
      // One path is one row in a slot, so two entries for it would be two answers and only one
      // that can win - refused, like the Command editor's save, rather than picking one.
      for (const path of duplicatePaths(entries)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["commands", slot],
          message: `lists ${commandDocumentPathLabel(path)} more than once`,
        });
      }
      entries.forEach((entry, index) => {
        const problem = entry.argv ? commandTemplateProblem(slot, entry.argv) : null;
        if (problem) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commands", slot, index, "argv"], message: problem });
        }
      });
    }
    for (const path of duplicatePaths(document.testing ?? [])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["testing"],
        message: `lists ${commandDocumentPathLabel(path)} more than once`,
      });
    }
  });
export type CommandDocument = z.infer<typeof CommandDocumentSchema>;

/** Each refusal as one line naming where it is: `commands.lint[1].argv: ...`. */
export function commandDocumentIssueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.reduce<string>((text, part) => (
      typeof part === "number" ? `${text}[${part}]` : text ? `${text}.${part}` : String(part)
    ), "");
    // A union-free schema still words an unknown key as "Unrecognized key(s) in object", which
    // is the right refusal for `maxRuns` or `defaults` and reads fine as is.
    return where ? `${where}: ${issue.message}` : issue.message;
  });
}

/**
 * A pasted or uploaded document, parsed and validated, or every reason it is not one.
 *
 * Text rather than a value, because the Library holds what the operator typed: a JSON syntax
 * error is a refusal of its own, said before any schema rule.
 */
export function parseCommandDocumentText(
  text: string,
): { ok: true; document: CommandDocument } | { ok: false; problems: string[] } {
  if (text.trim() === "") return { ok: false, problems: ["Paste or upload a document first."] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (caught) {
    return { ok: false, problems: [`Not valid JSON: ${caught instanceof Error ? caught.message : String(caught)}`] };
  }
  const parsed = CommandDocumentSchema.safeParse(value);
  return parsed.success
    ? { ok: true, document: parsed.data }
    : { ok: false, problems: commandDocumentIssueLines(parsed.error) };
}

/**
 * Stored testing settings in one key order, so two rows that store the same keys compare equal
 * and an exported document reads the same way the Library lists the keys.
 */
export function canonicalTestingSettings(settings: StoredTestingSettings): StoredTestingSettings {
  const tests = settings.tests ?? {};
  const out: NonNullable<StoredTestingSettings["tests"]> = {};
  if (tests.patterns !== undefined) out.patterns = [...tests.patterns];
  if (tests.includeImporters !== undefined) out.includeImporters = tests.includeImporters;
  if (tests.smokeSet !== undefined) out.smokeSet = [...tests.smokeSet];
  return Object.keys(out).length > 0 ? { tests: out } : {};
}

// ---- Preview and apply -----------------------------------------------------------------------

export type CommandDocumentChangeKind = "add" | "change" | "remove";

export interface CommandDocumentCommandChange {
  slot: WorkflowCheckSlot;
  /** Repository-relative, `""` for the root. */
  path: string;
  kind: CommandDocumentChangeKind;
  /** The stored argv, null for an add. */
  before: string[] | null;
  /** The argv the document sets, null for a removal. */
  after: string[] | null;
}

export interface CommandDocumentTestingChange {
  path: string;
  kind: CommandDocumentChangeKind;
  before: StoredTestingSettings | null;
  after: StoredTestingSettings | null;
}

/**
 * The revisions a preview was computed against: every slot the document names, and every
 * testing path it names (0 where nothing is stored). Apply recomputes them and refuses with 409
 * when any has moved, so what is written is exactly what the operator reviewed.
 */
export interface CommandDocumentBasis {
  commands: Partial<Record<WorkflowCheckSlot, number>>;
  testing: Record<string, number>;
}

export interface CommandDocumentPreview {
  /** The repository's canonical main checkout the document applies to. */
  repoRoot: string;
  /** Every Command add, change and removal, in slot order and then by path. */
  commands: CommandDocumentCommandChange[];
  /** Every testing settings add, change and removal, by path. */
  testing: CommandDocumentTestingChange[];
  /** Entries that already match what is stored, or remove a row that is not there. */
  unchanged: number;
  /** Refusals that block apply: a slot over its override cap, a path that is not a folder here. */
  problems: string[];
  basis: CommandDocumentBasis;
}

/**
 * How large a request carrying one document may be, in bytes: a cheap guard against an absurd
 * body before it is parsed, not a second opinion on what a valid document holds. A real
 * monorepo's document is a few kilobytes; the schema and the override cap are the real bounds.
 */
export const COMMAND_DOCUMENT_BODY_MAX_BYTES = 8 * 1024 * 1024;

const RepoRootSchema = z.string().min(1).max(WORKFLOW_LIMITS.checkRepoRoot);

/**
 * A preview request. The document is carried as an unknown value and validated on its own, so
 * a refusal can list every problem in words rather than as one schema dump.
 */
export const CommandDocumentPreviewRequestSchema = z.object({
  repoRoot: RepoRootSchema,
  document: z.unknown(),
}).strict();

const RevisionSchema = z.number().int().min(0);

export const CommandDocumentBasisSchema = z.object({
  commands: z.record(z.enum(WORKFLOW_CHECK_SLOTS), RevisionSchema),
  testing: z.record(z.string().max(WORKFLOW_LIMITS.checkRepoRoot), RevisionSchema),
}).strict();

/** A proposal id: the daemon's own UUID, bounded so a hand-typed one cannot grow a request. */
const ProposalIdSchema = z.string().min(1).max(64);

export const CommandDocumentApplyRequestSchema = z.object({
  repoRoot: RepoRootSchema,
  document: z.unknown(),
  basis: CommandDocumentBasisSchema,
  /**
   * The pending proposal this preview was opened from, when it was. Applying clears exactly
   * that proposal, and only while it is still the repository's pending one: a newer proposal
   * that replaced it while the operator was reviewing stays pending.
   */
  proposalId: ProposalIdSchema.optional(),
}).strict();
export type CommandDocumentApplyRequest = z.infer<typeof CommandDocumentApplyRequestSchema>;

export interface CommandDocumentApplied {
  repoRoot: string;
  /** What was written: the preview the apply was checked against. */
  preview: CommandDocumentPreview;
  /**
   * Whether applying cleared the pending proposal the request named. False when it named none,
   * or when a newer proposal had replaced it (which stays pending).
   */
  proposalCleared?: boolean;
}

export interface CommandDocumentExport {
  repoRoot: string;
  document: CommandDocument;
}

/**
 * How many entries a document lists, every slot and testing settings together: what a proposal
 * says it covers before anyone has previewed it against what is stored.
 */
export function commandDocumentEntryCount(document: CommandDocument): number {
  const commands = WORKFLOW_CHECK_SLOTS.reduce((sum, slot) => sum + (document.commands?.[slot]?.length ?? 0), 0);
  return commands + (document.testing?.length ?? 0);
}

/** How many rows a preview changes, all kinds and both catalogs together. */
export function commandDocumentChangeCount(preview: Pick<CommandDocumentPreview, "commands" | "testing">): number {
  return preview.commands.length + preview.testing.length;
}

/** `2 to add, 1 to change, 1 to remove`, or `No changes`. */
export function commandDocumentChangeSummary(preview: Pick<CommandDocumentPreview, "commands" | "testing">): string {
  const counts: Record<CommandDocumentChangeKind, number> = { add: 0, change: 0, remove: 0 };
  for (const change of [...preview.commands, ...preview.testing]) counts[change.kind] += 1;
  const parts = (["add", "change", "remove"] as const)
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} to ${kind}`);
  return parts.length > 0 ? parts.join(", ") : "No changes";
}

// ---- Proposals -------------------------------------------------------------------------------

/**
 * How large a proposed document may be, serialized, in bytes.
 *
 * Far below the import body limit on purpose. A pending proposal is held in the daemon and sent
 * to every open window in the snapshot and on every change, while an imported document is read
 * once. A real monorepo's document is a few kilobytes, so this bounds the wire, not real use.
 */
export const COMMAND_DOCUMENT_PROPOSAL_MAX_BYTES = 256 * 1024;

/**
 * A Command document an agent session proposed for one of its task's repositories, waiting for
 * the operator. Nothing in it is live: the operator opens it in the same preview an import
 * gets, and applies or dismisses it there. A repository holds at most one, and a newer proposal
 * replaces the older.
 *
 * Machine state, never configuration: it is not in a settings backup.
 */
export interface CommandDocumentProposal {
  /** The daemon's id for this proposal. A replacement gets a new one. */
  id: string;
  /** The task repository's canonical main checkout, which the document applies to. */
  repoRoot: string;
  document: CommandDocument;
  proposedAt: number;
  /** The proposing task and session, as they were named when it proposed, for display. */
  taskId: string | null;
  taskTitle: string | null;
  sessionId: string | null;
  sessionName: string | null;
}

/** `POST /api/command-documents/proposals/dismiss`: drop one pending proposal unapplied. */
export const CommandDocumentProposalDismissSchema = z.object({
  repoRoot: RepoRootSchema,
  proposalId: ProposalIdSchema,
}).strict();
export type CommandDocumentProposalDismiss = z.infer<typeof CommandDocumentProposalDismissSchema>;

/** What `propose_command_document` answers the agent: what was stored, and what review will show. */
export interface CommandDocumentProposed {
  proposal: Pick<CommandDocumentProposal, "id" | "repoRoot" | "proposedAt">;
  /** The id of the pending proposal this one replaced, or null. */
  replaced: string | null;
  /** The preview against what is stored now, exactly as the operator's review computes it. */
  preview: CommandDocumentPreview;
}
