export interface KeepAwakeObserver {
  command: string;
  args: string[];
  held(listing: string, reason: string): boolean;
  /** What to do when the OS refuses the listing, where the usual cause is known. */
  refused?: string;
}

export function powercfgSections(listing: string): Map<string, string>;
export function keepAwakeObserver(platform: string): KeepAwakeObserver;
export function listAssertions(
  observer: KeepAwakeObserver,
  run?: (command: string, args: string[], options: object) => string,
): string;
