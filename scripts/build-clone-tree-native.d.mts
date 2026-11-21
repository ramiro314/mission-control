export type CloneTreeBuildTarget =
  | { kind: "skip"; platform: string }
  | { kind: "build"; arch: "arm64" | "x64" };

export function cloneTreeBuildTarget(platform: string, arch: string): CloneTreeBuildTarget;
