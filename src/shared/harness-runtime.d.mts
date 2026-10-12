// Hand-written types for harness-runtime.mjs so the TypeScript consumers
// (src/server/config.ts, src/mcp/server.ts, vite.config.ts) can import it.

export function envVar(suffix: string): string | undefined;

export const PORT: number;
export const HOST: string;
export const BASE_URL: string;

export const STATE_DIRS: readonly string[];
export function stateDir(): string;
export function migrateStateDir(): { from: string; to: string } | null;
export function tokenPath(): string;
export const MISSION_API_TOKEN_ENV: string;
export const MISSION_API_TOKEN_FILE_ENV: string;
export function readToken(): string;
export function readClientToken(): string;
export function ensureToken(): string;
export const SCOUT_SUBMISSION_CREDENTIAL_HEADER: string;
export const SCOUT_SUBMISSION_CREDENTIAL_ENV: string;
export const SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV: string;
export const SCOUT_SESSION_LOCATOR_ENV: string;
export const MISSION_SESSION_ID_ENV: string;
export const MISSION_AGENT_SESSION_ID_ENV: string;
export const AGENT_RUNTIME_DIR_ENV: string;
export const AGENT_STATE_ROOT: string;
export const AGENT_CAPABILITIES_ROOT: string;
export function agentRuntimeBase(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
export class AgentRuntimeRootRefusedError extends Error {
  constructor(path: string, info: import("node:fs").Stats);
  readonly path: string;
}
export function assertPrivateAgentRuntimeRoot(path: string): void;
export function agentRuntimeRoot(name: string, options?: { create?: boolean }): string;
export function legacyAgentRuntimeRoot(name: string, platform?: NodeJS.Platform): string | null;
export function scoutSubmissionCredentialPath(cwd: string): string;
export function isolatedScoutSubmissionCredentialPath(cwd: string): string;
export function readScoutSubmissionCredential(cwd: string): string;
export function sessionScoutCredentialDirectory(): string;
export function sessionScoutCredentialPath(identity: string): string;
export function readSessionScoutSubmissionCredential(cwd: string): string;

export interface TerminalEnv {
  tmuxPane: string | undefined;
  weztermPane: string | undefined;
  itermSession: string | undefined;
  termProgram: string | undefined;
}

export function captureTerminalEnv(): TerminalEnv;
