export const DESKTOP_ENTRY_FILE: string;
export const LINUX_ONLY_MESSAGE: string;

export interface DesktopEntryPaths {
  entry: string;
  autostart: string;
}

export function desktopEntryPaths(input?: { env?: NodeJS.ProcessEnv; home?: string }): DesktopEntryPaths;

export function desktopEntry(input: { electron: string; checkout: string }): string;

export interface AutostartFs {
  exists(path: string): boolean;
  copy(from: string, to: string): void;
  remove(path: string): void;
  mkdir(path: string): void;
}

export interface LinuxAutostart {
  installed(): boolean;
  enabled(): boolean;
  set(enabled: boolean): void;
}

export function linuxAutostart(paths?: DesktopEntryPaths, fs?: AutostartFs): LinuxAutostart;
