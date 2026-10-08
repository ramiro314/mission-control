import { expect } from "@playwright/test";

import { UI_CONFIG_DEFAULTS } from "../../src/shared/protocol.ts";
import type { DisplayItemId } from "../../src/web/lib/board-card.ts";
import type { DaemonHandle } from "./daemon.ts";

/**
 * The shipped hidden-items list with some ids un-hidden.
 *
 * `hiddenDisplayItems` is replaced wholesale rather than merged per id, so a spec that needs
 * one off-by-default Display item cannot ask for it in isolation - it has to send the whole
 * array. Sending a literal is what makes a spec quietly depend on which items ship hidden:
 * `[]` also turns ON every future item that ships off, and `["worktree"]` freezes today's
 * answer into a spec that is not about the worktree at all.
 *
 * Derived from `UI_CONFIG_DEFAULTS` instead, so a spec says the one thing it means - "with
 * the workflow details switched on, otherwise as shipped" - and a later default change
 * carries through it rather than silently changing what it was testing.
 *
 * `ids` is typed as `DisplayItemId` rather than a bare `string`, so a typo'd id is a
 * compile error here instead of a silent no-op: `.includes()` against a misspelled id never
 * matches, `hiddenDisplayItems` comes back unchanged, and the spec fails later at whatever
 * assertion expected the item to be visible - reporting the wrong thing entirely.
 */
export function displayItemsShowing(...ids: readonly DisplayItemId[]): string[] {
  return UI_CONFIG_DEFAULTS.hiddenDisplayItems.filter((hidden) => !ids.includes(hidden));
}

/**
 * Wait until the daemon holds each of `ids` hidden, or each of them shown.
 *
 * A Display checkbox flips on its optimistic write, before its PUT lands, and a full page
 * load straight after it can abort that PUT on a slow runner - which reloads into a preference
 * that was never saved. Call this between the click and the reload or navigation.
 */
export async function expectDaemonHides(
  daemon: DaemonHandle,
  ids: readonly DisplayItemId[],
  hidden: boolean,
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await fetch(`${daemon.baseURL}/api/ui/config`);
      const view = (await response.json()) as { config: { hiddenDisplayItems: string[] } };
      return ids.filter((id) => view.config.hiddenDisplayItems.includes(id) === hidden);
    }, { message: `the daemon saved ${ids.join(", ")} ${hidden ? "hidden" : "shown"}` })
    .toEqual([...ids]);
}
