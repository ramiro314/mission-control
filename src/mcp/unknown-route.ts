/**
 * Whether a 404 means the daemon does not know the route at all, as an older build answers,
 * rather than a route that ran and reported a missing session or task as a JSON `error`.
 *
 * The distinction is what keeps a real "no such task to adopt" from being reported as "update
 * Mission Control". Reads a clone, so the caller can still read the body afterwards.
 */
export async function isUnknownRoute(res: Response): Promise<boolean> {
  if (res.status !== 404) return false;
  try {
    return typeof ((await res.clone().json()) as { error?: unknown }).error !== "string";
  } catch {
    return true;
  }
}
