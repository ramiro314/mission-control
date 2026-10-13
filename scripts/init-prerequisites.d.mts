export const MIN_NODE_MAJOR: number;

export function nodeMajor(version: string): number | null;
export function nodePrerequisiteMessage(version: string): string | null;
export function chromiumPrerequisiteMessage(): string;

export const REQUIRED_ARCH: string;
export function archPrerequisiteMessage(arch: string): string | null;
export function gitPrerequisiteMessage(installed: boolean): string | null;
export function ghPrerequisiteMessage(state: {
  installed: boolean;
  authenticated: boolean;
}): string | null;
export interface BuildToolchain {
  heading: string;
  available: string;
  probes: { tool: string; command: [string, ...string[]] }[];
}
export function buildToolchain(
  platform: string,
  env?: Record<string, string | undefined>,
): BuildToolchain | null;
export function buildToolsPrerequisiteMessage(state: {
  platform: string;
  missing: string[];
}): string | null;
export function lsofRequired(platform: string): boolean;
export function lsofPrerequisiteMessage(installed: boolean): string | null;
