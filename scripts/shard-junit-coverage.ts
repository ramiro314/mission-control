// Did a shard run every file it was dealt? `node --import tsx scripts/shard-junit-coverage.ts
// <file-list> <junit-prefix>` reads the shard's file list, one repository-relative path per line,
// and every `<junit-prefix>-<n>.xml` its batches wrote, and names each listed file no test case
// reports. A file that fails to load or is ended by the watchdog still reports a failing case, so
// a missing file is one the runner never started.
//
// The Windows unit shard needs this because a dropped file is otherwise silent: on run
// 37841183938 a win32 command line cut at 8,191 characters dropped the last third of every
// shard's files, and the runner reported a clean summary of the rest.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJUnit } from "../src/shared/junit.ts";

/** The listed files no case in `reports` names, in list order. */
export function unreportedFiles(files: readonly string[], reports: readonly string[]): string[] {
  const reported = new Set<string>();
  for (const xml of reports) {
    const parsed = parseJUnit(xml);
    if (!parsed.ok) throw new Error(parsed.error);
    for (const { file } of parsed.results.cases) if (file) reported.add(file.replaceAll("\\", "/"));
  }
  return files.filter((file) => {
    if (reported.has(file)) return false;
    for (const path of reported) if (path.endsWith(`/${file}`)) return false;
    return true;
  });
}

/** The `<prefix>-<n>.xml` files beside `prefix`, in batch order. */
export function batchReports(prefix: string): string[] {
  const dir = dirname(prefix);
  const pattern = new RegExp(`^${basename(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.xml$`);
  return readdirSync(dir)
    .flatMap((name) => {
      const batch = pattern.exec(name)?.[1];
      return batch ? [{ name, batch: Number(batch) }] : [];
    })
    .sort((a, b) => a.batch - b.batch)
    .map(({ name }) => join(dir, name));
}

function main(): void {
  const [list, prefix] = process.argv.slice(2);
  if (!list || !prefix) throw new Error("usage: shard-junit-coverage.ts <file-list> <junit-prefix>");
  const files = readFileSync(list, "utf8").split(/\r?\n/).filter(Boolean);
  const reports = batchReports(prefix);
  if (!reports.length) throw new Error(`no ${basename(prefix)}-<n>.xml results beside ${prefix}`);
  const missing = unreportedFiles(files, reports.map((path) => readFileSync(path, "utf8")));
  if (missing.length) {
    console.error(`${missing.length} of ${files.length} dealt files never ran:\n${missing.join("\n")}`);
    process.exit(1);
  }
  console.log(`All ${files.length} dealt files reported, across ${reports.length} JUnit batch results`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`shard-junit-coverage: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
