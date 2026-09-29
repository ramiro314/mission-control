// The `{files}` / `{junit}` test command template, filled the same way everywhere.
//
// Browser-safe and dependency-free on purpose: the daemon's `affected-tests` check fills it to
// run the selected tests, and the CI flake report action (which bundles this module) fills it
// to rerun the failed test files. One expansion keeps the two from disagreeing about what a
// template means.

/** The argv element replaced by one element per test file. */
export const AFFECTED_TESTS_FILES_PLACEHOLDER = "{files}";
/** Replaced, wherever it appears inside an element, by the path JUnit results are read from. */
export const AFFECTED_TESTS_JUNIT_PLACEHOLDER = "{junit}";

/** The template with `{files}` and `{junit}` filled in. */
export function expandTestCommandTemplate(
  template: readonly string[],
  files: readonly string[],
  junitPath: string,
): string[] {
  return template.flatMap((arg) =>
    arg === AFFECTED_TESTS_FILES_PLACEHOLDER
      ? [...files]
      : [arg.split(AFFECTED_TESTS_JUNIT_PLACEHOLDER).join(junitPath)]);
}
