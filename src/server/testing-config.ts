import { join } from "node:path";
import {
  TESTING_CONFIG_LIMITS,
  TESTING_CONFIG_PATH,
  TESTING_LOCAL_CONFIG_PATH,
  mergeTestingLayers,
  parseTestingConfig,
  parseTestingLocalConfig,
  storedTestingSettingsKeys,
  type LayeredTestingConfig,
  type StoredTestingLayer,
  type TestingConfig,
} from "@shared/testing-config.ts";
import { readRepoDoc, realpathOr } from "./util/repo-doc.ts";

/** A project's effective testing settings, or why there are none to use. */
export type TestingConfigRead =
  | { ok: true; merged: LayeredTestingConfig }
  /** No committed file and no stored settings: the project has not opted in. Not an error. */
  | { ok: false; kind: "missing"; note: string }
  /** The committed file cannot be used: it is part of the change, so the change is at fault. */
  | { ok: false; kind: "invalid"; note: string }
  /** The operator's local override cannot be used: their machine, not the change. */
  | { ok: false; kind: "invalid-local"; note: string };

function readFile(root: string, rel: string): { text: string } | { tooLarge: true } | null {
  const doc = readRepoDoc(root, realpathOr(root), join(root, rel), TESTING_CONFIG_LIMITS.fileBytes);
  if (!doc) return null;
  return doc.truncated ? { tooLarge: true } : { text: doc.text };
}

/**
 * Read `.mission/testing.json` from `treeRoot` (the check's worktree, at the commit under
 * review), lay the repository's stored settings over it, and lay `.mission/testing.local.json`
 * from `localRoot` (the operator's own checkout) over both.
 *
 * Two roots because the local file is gitignored: a pooled check tree pinned to a commit does
 * not reliably carry it, while the checkout the operator edits does. Both are read through
 * `readRepoDoc`, so a symlink cannot point either read outside its repository.
 *
 * The gate has settings when the committed file exists or the stored row sets at least one key.
 * The local file alone does not opt a repository in, exactly as before stored settings existed:
 * it overrides settings, it is not a source of them. Stored rows were validated when they were
 * saved, so only the two files can be invalid here.
 */
export function readTestingConfig(
  treeRoot: string,
  localRoot: string | null,
  stored: StoredTestingLayer | null = null,
): TestingConfigRead {
  const layer = stored && storedTestingSettingsKeys(stored.settings).length > 0 ? stored : null;
  const committed = readFile(treeRoot, TESTING_CONFIG_PATH);
  if (!committed && !layer) {
    return {
      ok: false,
      kind: "missing",
      note: `This repository has no ${TESTING_CONFIG_PATH} and no stored testing settings, so no tests could be selected and this gate was skipped.`,
    };
  }
  let base: TestingConfig | null = null;
  if (committed) {
    if ("tooLarge" in committed) {
      return { ok: false, kind: "invalid", note: `${TESTING_CONFIG_PATH} is larger than ${TESTING_CONFIG_LIMITS.fileBytes} bytes.` };
    }
    const parsed = parseTestingConfig(committed.text);
    if (!parsed.ok) return { ok: false, kind: "invalid", note: parsed.error };
    base = parsed.config;
  }

  const local = localRoot ? readFile(localRoot, TESTING_LOCAL_CONFIG_PATH) : null;
  if (local && "tooLarge" in local) {
    return { ok: false, kind: "invalid-local", note: `${TESTING_LOCAL_CONFIG_PATH} is larger than ${TESTING_CONFIG_LIMITS.fileBytes} bytes.` };
  }
  let override = null;
  if (local) {
    const parsedLocal = parseTestingLocalConfig(local.text);
    if (!parsedLocal.ok) return { ok: false, kind: "invalid-local", note: parsedLocal.error };
    override = parsedLocal.config;
  }
  return { ok: true, merged: mergeTestingLayers(base, layer, override) };
}
