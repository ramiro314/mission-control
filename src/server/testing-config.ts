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
  /** No committed file, no stored settings and no local file: not opted in. Not an error. */
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
 * The gate has settings when ANY layer exists: the committed file, a stored row that sets at
 * least one key, or the local file. With none of the three it is skipped. A local file alone
 * opts that checkout in, laid over the defaults. Stored rows were validated when they were saved,
 * so only the two files can be invalid here, and each keeps its own rule: an invalid committed
 * file fails the gate and an invalid local file makes it unavailable.
 */
export function readTestingConfig(
  treeRoot: string,
  localRoot: string | null,
  stored: StoredTestingLayer | null = null,
): TestingConfigRead {
  const layer = stored && storedTestingSettingsKeys(stored.settings).length > 0 ? stored : null;
  const committed = readFile(treeRoot, TESTING_CONFIG_PATH);
  const local = localRoot ? readFile(localRoot, TESTING_LOCAL_CONFIG_PATH) : null;
  if (!committed && !layer && !local) {
    return {
      ok: false,
      kind: "missing",
      note: `This repository has no ${TESTING_CONFIG_PATH}, no stored testing settings and no ${TESTING_LOCAL_CONFIG_PATH}, so no tests could be selected and this gate was skipped.`,
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
