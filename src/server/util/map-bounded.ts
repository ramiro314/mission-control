/**
 * `Promise.all(items.map(map))` with at most `limit` callbacks in flight, keeping the input
 * order in the output. For work that holds a scarce resource across its awaits, such as an open
 * file handle, where an unbounded fan-out over a large input can exhaust it.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await map(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return output;
}
