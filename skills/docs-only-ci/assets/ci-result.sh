# docs-only-ci: the one check a protected branch requires.
# Inputs, all through env: NEEDS_JSON (`toJSON(needs)`), DOCS_ONLY (the changes job's
# output), and SKIPPABLE, one job id per line. Passes only when every needed job succeeded,
# except that a job in SKIPPABLE may have been skipped when DOCS_ONLY is exactly `true`.
# Otherwise fails, naming each offending job and its result.

skippable() {
  while read -r id; do
    if [ -n "$id" ] && [ "$id" = "$1" ]; then return 0; fi
  done <<< "${SKIPPABLE:-}"
  return 1
}

if ! results=$(printf '%s' "${NEEDS_JSON:-}" | jq -r 'to_entries[] | "\(.key) \(.value.result)"'); then
  echo "::error::CI result: NEEDS_JSON could not be read."
  exit 1
fi
if [ -z "$results" ]; then
  echo "::error::CI result: NEEDS_JSON lists no jobs."
  exit 1
fi

failed=0
while read -r job result; do
  if [ "$result" = success ]; then
    echo "$job: success"
  elif [ "$result" = skipped ] && [ "${DOCS_ONLY:-}" = true ] && skippable "$job"; then
    echo "$job: skipped (docs-only change)"
  else
    echo "::error::$job: $result"
    failed=1
  fi
done <<< "$results"

if [ "$failed" -ne 0 ]; then
  echo "CI result: failed (docs_only=${DOCS_ONLY:-unset})."
  exit 1
fi
echo "CI result: passed (docs_only=${DOCS_ONLY:-unset})."
