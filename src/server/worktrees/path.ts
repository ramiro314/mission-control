import { resolve } from "node:path";
import { physicalPathSync } from "../util/physical-path.ts";

/** Canonicalize an existing checkout path, while keeping missing legacy paths comparable. */
export function canonicalWorktreePath(path: string): string {
  try {
    return physicalPathSync(path);
  } catch {
    return resolve(path);
  }
}
