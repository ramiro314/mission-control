// Pure policy for Mission-owned scripts only. Never substitute this for user commands.
export function resolveOwnedRuntime({executable, kind}) {
  if (typeof executable !== 'string' || (!executable.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(executable)) || !['node', 'electron'].includes(kind)) throw new Error('An absolute owned runtime and explicit context are required');
  return {command: executable, env: kind === 'electron' ? {ELECTRON_RUN_AS_NODE: '1'} : {}};
}

// The runtime this process runs on, as a Mission-owned script should be launched with it: a
// `node` binary as itself, anything else (the Electron app) with ELECTRON_RUN_AS_NODE=1.
export function resolveCurrentOwnedRuntime(execPath) {
  return resolveOwnedRuntime({executable: execPath, kind: /(^|[\\/])node(\.exe)?$/.test(execPath) ? 'node' : 'electron'});
}
