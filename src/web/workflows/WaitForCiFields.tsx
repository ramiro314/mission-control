import { useEffect, useState } from "react";
import { WAIT_FOR_CI_TIMEOUT_MINUTES } from "@shared/wait-for-ci.ts";

/**
 * The one field a Wait for CI node has: how long it waits for the pull request's CI before
 * blocking the run. Shared by the Graph rail and the Pipeline editor so both say the same.
 *
 * Kept as local text and committed only when it is a whole number in range, so typing "60"
 * does not pass through an out-of-range "6" that the schema would refuse.
 */
export function WaitForCiTimeoutField({
  value,
  readOnly,
  onChange,
}: {
  value: number;
  readOnly: boolean;
  onChange: (timeoutMinutes: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const { min, max } = WAIT_FOR_CI_TIMEOUT_MINUTES;
  const parsed = Number(text);
  const valid = Number.isInteger(parsed) && parsed >= min && parsed <= max;
  return (
    <label>
      Timeout (minutes)
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        disabled={readOnly}
        value={text}
        aria-invalid={!valid}
        onChange={(event) => {
          setText(event.target.value);
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
        }}
        onBlur={() => setText(String(value))}
      />
      <small>
        {valid
          ? "Blocks the run when CI is still running, or never appeared, after this long."
          : `Enter a whole number from ${min} to ${max}.`}
      </small>
    </label>
  );
}

/** What the node does, said once for both editors. */
export const WAIT_FOR_CI_EXPLANATION =
  "Waits for the pull request's CI on the head the Pull Request action proved. Green CI passes, "
  + "including green with flaky tests that passed on rerun. A failing check returns to the session "
  + "with each failing check named. It blocks the run when CI times out, never appears, or has no "
  + "\"Flaky tests\" check. It reads CI through the GitHub Inspector, which must be on.";
