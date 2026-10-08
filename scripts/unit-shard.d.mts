export const UNIT_TEST_GLOB: string;
export const SHARD_TIMINGS_PATH: string;

export type ShardTimings = Record<string, unknown>;
export type ShardSuite = "unit" | "windows-unit" | "windows-e2e";

export const SHARD_SUITES: Record<ShardSuite, { dir: string; glob: string; timings: string }>;

export function suiteFiles(root: string, suite?: ShardSuite): string[];
export function unitTestFiles(root: string): string[];
export function readShardTimings(root: string, suite?: ShardSuite): ShardTimings;
export function shardWeights(files: readonly string[], timings: ShardTimings): Map<string, number>;
export function partitionUnitTests(files: readonly string[], timings: ShardTimings, total: number): string[][];
export function parseShardSpec(spec: string | undefined): { index: number; total: number };
