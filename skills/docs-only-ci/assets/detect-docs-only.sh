# docs-only-ci: decide whether a pull request changed only docs paths.
# Inputs, all through env: EVENT_NAME, BASE_SHA, HEAD_SHA, and DOCS_ONLY_PATHS, one shell
# `case` pattern per line (`*` matches across `/`, so `docs/*` is every depth under docs/).
# Prints docs_only=true|false and appends it to $GITHUB_OUTPUT when set. Every doubt
# resolves to false, which runs the full suite; a detection problem never fails the step.

decide() {
  echo "$2"
  echo "docs_only=$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "docs_only=$1" >> "$GITHUB_OUTPUT"; fi
  exit 0
}

if [ "${EVENT_NAME:-}" != "pull_request" ]; then
  decide false "Not a pull request (${EVENT_NAME:-no event}): run everything."
fi
if [ -z "${BASE_SHA:-}" ] || [ -z "${HEAD_SHA:-}" ]; then
  decide false "No base or head commit: run everything."
fi
if [ -z "$(printf '%s' "${DOCS_ONLY_PATHS:-}" | tr -d '[:space:]')" ]; then
  decide false "No docs patterns configured: run everything."
fi

# --no-renames is required: with rename detection, a file moved from src/ into docs/ is
# listed only by its docs/ path, and the removed source file would look like a docs change.
if ! changed=$(git diff --no-renames --name-only "$BASE_SHA...$HEAD_SHA"); then
  decide false "git diff $BASE_SHA...$HEAD_SHA failed: run everything."
fi
if [ -z "$changed" ]; then
  decide false "No changed files found: run everything."
fi

while IFS= read -r path; do
  [ -n "$path" ] || continue
  matched=false
  while read -r pattern; do
    [ -n "$pattern" ] || continue
    # Unquoted on purpose: the pattern is a glob, not a literal.
    case "$path" in $pattern) matched=true; break ;; esac
  done <<< "$DOCS_ONLY_PATHS"
  if [ "$matched" != true ]; then
    decide false "Not a docs path: $path"
  fi
done <<< "$changed"

decide true "Every changed path matches the docs patterns."
