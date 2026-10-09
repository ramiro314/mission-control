export type ProcessInspectionBuildTarget =
  | { kind: "skip"; platform: string }
  | { kind: "build"; arch: "arm64" | "x64" };

export function processInspectionBuildTarget(platform: string, arch: string): ProcessInspectionBuildTarget;
