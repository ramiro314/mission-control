export interface KeepAwakeObserver {
  command: string;
  args: string[];
  held(listing: string, reason: string): boolean;
}

export function powercfgSections(listing: string): Map<string, string>;
export function keepAwakeObserver(platform: string): KeepAwakeObserver;
