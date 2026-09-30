import { expect, test } from "../fixtures/test.ts";
import { installEffectGap, typeInEffectGapWhenEnabled } from "../fixtures/effect-gap.ts";

/**
 * What an operator types into a telemetry destination survives a config refresh that lands
 * underneath it.
 *
 * The regression behind this: both destination forms used to copy the daemon's endpoint into
 * local state from an effect. A refresh committed, its effect was still queued with the
 * "nothing typed yet" closure, a keystroke landed in between, and the effect then put the
 * stored endpoint - empty - back over the typed one. On CI that emptied the field
 * `telemetry-settings.spec.ts` had just filled, so the message it waited for never rendered.
 *
 * The gap is a few milliseconds wide on a busy runner and zero on an idle one, so this spec
 * opens it deliberately and types inside it: see `e2e/fixtures/effect-gap.ts`. The refresh
 * used is the daemon's answer to the consent switch, because the switch is disabled while
 * that write is in flight - so the switch becoming enabled again IS the commit of the
 * refreshed config.
 */
const DESTINATIONS = [
  {
    name: "the operator's own backend",
    field: "Telemetry export endpoint",
    stored: "",
    typed: "http://telemetry.example.com:4318",
  },
  {
    // Adopted by the same effect as the endpoint above it, so it lost the same race - back to
    // the stored header name rather than to nothing.
    name: "the credential header of the operator's own backend",
    field: "Telemetry credential header name",
    stored: "authorization",
    typed: "x-api-key",
  },
  {
    name: "the product analytics collector",
    field: "Product analytics endpoint",
    stored: "",
    typed: "http://127.0.0.1:14398",
  },
];

for (const destination of DESTINATIONS) {
  test(`what is typed for ${destination.name} survives a config refresh landing under it`, async ({
    dashboard,
    daemon,
  }) => {
    await installEffectGap(dashboard);
    await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
    await dashboard.reload();

    const collect = dashboard.getByLabel("Collect Mission Control telemetry on this machine");
    const field = dashboard.getByLabel(destination.field);
    await expect(collect).toBeEnabled();
    // The panel has heard from the daemon, so nothing above the switch is still going to move.
    await expect(dashboard.getByText(/has not reported its telemetry state yet/)).toBeHidden();
    await expect(field).toHaveValue(destination.stored);

    // The keystroke that used to lose: typed after the daemon's answer to the switch has
    // committed, and before that commit's effects have run.
    const typed = await typeInEffectGapWhenEnabled(collect, field, destination.typed);
    await collect.check();
    await typed();

    await expect(collect).toBeChecked();
    await expect(field).toHaveValue(destination.typed);
  });
}
