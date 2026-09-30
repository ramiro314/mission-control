import type { Locator, Page } from "@playwright/test";

/**
 * Types into a field in the gap between a React commit and that commit's passive effects.
 *
 * That gap is real and it is where a whole class of bug lives. A render caused by something
 * other than an input event - a fetch resolving, a server frame arriving - commits in one
 * scheduler task and runs its `useEffect`s in a LATER one. On an idle machine the two are
 * back to back and nothing fits between them. On a busy CI runner the render overruns the
 * scheduler's 5ms slice, the scheduler yields, and a keystroke can land in between: its
 * handler runs first, and the effects then run with closures from before the keystroke. An
 * effect that copies a prop into state at that moment overwrites what was just typed, which
 * is how `telemetry-settings.spec.ts` flaked on CI and never on a laptop.
 *
 * No amount of CPU load reproduces that reliably, so this opens the gap on purpose and puts
 * the keystroke in it from inside the page, where there is no timing to lose:
 *
 *  - while armed, the clock the scheduler reads advances 6ms per read, so every slice has
 *    "expired" and the scheduler yields after each task, exactly as it does when a render is
 *    slow. The commit and its effects are therefore separate tasks;
 *  - a `MutationObserver` on the control that the awaited commit re-enables fires as a
 *    microtask at the end of the commit's task, which is before the task holding its effects.
 *    The typing happens there.
 *
 * The keystroke is therefore synthetic - the field's value set and an `input` event
 * dispatched, the way React's own test utilities type - because a `fill()` sent from the test
 * process cannot be aimed at a gap this narrow. Everything else in a spec using this stays an
 * ordinary click and an ordinary assertion.
 *
 * This leans on React's scheduler slicing by `performance.now()`. If a React upgrade changes
 * that, the commit and its effects run in one task again and a spec built on this passes
 * without exercising the gap; rerun it against a build with the bug restored when upgrading.
 */

interface EffectGap {
  armed: boolean;
  typed: Promise<void> | null;
}

type GapWindow = Window & { __missionEffectGap?: EffectGap };

/** Register the clock. Call before the navigation or reload that loads the app. */
export async function installEffectGap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const gap: EffectGap = { armed: false, typed: null };
    (window as GapWindow).__missionEffectGap = gap;
    const realNow = performance.now.bind(performance);
    let skew = 0;
    // Still monotonic once disarmed: the skew stops growing, it is never taken back.
    performance.now = () => realNow() + (gap.armed ? (skew += 6) : skew);
  });
}

/**
 * Arm the gap: the next commit that leaves `control` enabled gets `text` typed into `field`
 * before its effects run. Do whatever disables `control` and starts the work next, then await
 * the returned function, which resolves once the typing has happened and disarms the clock.
 */
export async function typeInEffectGapWhenEnabled(
  control: Locator,
  field: Locator,
  text: string,
): Promise<() => Promise<void>> {
  const controlHandle = await control.elementHandle();
  await field.evaluate(
    (input, { control, text }) => {
      const gap = (window as GapWindow).__missionEffectGap!;
      const watched = control as HTMLInputElement;
      let wasDisabled = watched.disabled;
      gap.armed = true;
      gap.typed = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          const reEnabled = wasDisabled && !watched.disabled;
          wasDisabled = watched.disabled;
          if (!reEnabled) return;
          observer.disconnect();
          const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
            .set!;
          setValue.call(input, text);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          gap.armed = false;
          resolve();
        });
        observer.observe(watched, { attributes: true, attributeFilter: ["disabled"] });
      });
    },
    { control: controlHandle, text },
  );
  const page = field.page();
  return async () => {
    await page.evaluate(() => (window as GapWindow).__missionEffectGap!.typed);
  };
}
