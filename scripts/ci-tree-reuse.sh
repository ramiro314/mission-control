#!/usr/bin/env bash
# Tree reuse: a push to `main` skips the Node 24 suite, `gates` and e2e when the merged pull
# request's latest green CI run already tested the identical tree. See "Tree reuse on `main`" in
# .github/workflows/ci.yml and docs/plans/ci-time-to-green/plan.md, section 6.
#
#   record <file>  Pull request runs. Writes the tree of the commit the run tests (the merge
#                  ref's `HEAD^{tree}`) and DOCS_ONLY to <file> as JSON. A problem warns and
#                  writes nothing, so the later `main` push finds no artifact and runs everything.
#   decide         Every run. Prints why, then tree_reused=true|false, and appends it to
#                  $GITHUB_OUTPUT when set. Every doubt resolves to false, which runs everything;
#                  a lookup problem never fails the step.
#
# Inputs, all through env. record: DOCS_ONLY. decide: EVENT_NAME, REF, SHA, REPO, WORKFLOW (the
# workflow file whose runs count, `ci.yml`), and GH_TOKEN for `gh`.
set -eo pipefail

record() {
  if [ -z "${1:-}" ]; then
    echo "::warning::tree reuse: record needs an output file; nothing recorded."
    return 0
  fi
  local tree
  if ! tree=$(git rev-parse 'HEAD^{tree}'); then
    echo "::warning::tree reuse: git rev-parse HEAD^{tree} failed; nothing recorded."
    return 0
  fi
  if ! jq -n --arg tree "$tree" --arg docs_only "${DOCS_ONLY:-}" '{tree: $tree, docs_only: $docs_only}' > "$1"; then
    rm -f "$1"
    echo "::warning::tree reuse: writing $1 failed; nothing recorded."
    return 0
  fi
  echo "Recorded tree $tree (docs_only=${DOCS_ONLY:-unset}) in $1."
}

decide() {
  echo "$2"
  echo "tree_reused=$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "tree_reused=$1" >> "$GITHUB_OUTPUT"; fi
  exit 0
}

is_sha() {
  [ "${#1}" -eq 40 ] && case "$1" in *[!0-9a-f]*) false ;; esac
}

reuse() {
  if [ "${EVENT_NAME:-}" != push ]; then
    decide false "Not a push (${EVENT_NAME:-no event}): run everything."
  fi
  if [ "${REF:-}" != refs/heads/main ]; then
    decide false "Not a push to main (${REF:-no ref}): run everything."
  fi
  if ! is_sha "${SHA:-}" || [ -z "${REPO:-}" ] || [ -z "${WORKFLOW:-}" ]; then
    decide false "Missing SHA, REPO or WORKFLOW: run everything."
  fi

  local pulls merged number head
  if ! pulls=$(gh api "repos/$REPO/commits/$SHA/pulls"); then
    decide false "Listing the pull requests of $SHA failed: run everything."
  fi
  if ! merged=$(jq -r '[.[] | select(.merged_at != null)] | if length == 1 then "\(.[0].number) \(.[0].head.sha)" else "\(length)" end' <<< "$pulls"); then
    decide false "The pull requests of $SHA could not be read: run everything."
  fi
  read -r number head <<< "$merged"
  if [ -z "${head:-}" ]; then
    decide false "$SHA maps to ${number:-no} merged pull requests, not exactly one: run everything."
  fi
  if ! is_sha "$head"; then
    decide false "Pull request #$number has no readable head commit: run everything."
  fi

  local runs latest run status conclusion
  if ! runs=$(gh api "repos/$REPO/actions/workflows/$WORKFLOW/runs?event=pull_request&head_sha=$head&per_page=100"); then
    decide false "Listing $WORKFLOW runs for #$number's head $head failed: run everything."
  fi
  if ! latest=$(jq -r '.workflow_runs | sort_by(.created_at) | last | if . == null then "" else "\(.id) \(.status) \(.conclusion)" end' <<< "$runs"); then
    decide false "The $WORKFLOW runs for #$number's head $head could not be read: run everything."
  fi
  if [ -z "$latest" ]; then
    decide false "No pull_request run of $WORKFLOW for #$number's head $head: run everything."
  fi
  read -r run status conclusion <<< "$latest"
  if [ "$status" != completed ] || [ "$conclusion" != success ]; then
    decide false "The newest run for #$number's head, $run, is $status/$conclusion, not a completed success: run everything."
  fi

  local dir recorded tree docs_only pushed
  if ! dir=$(mktemp -d); then
    decide false "No temporary directory for the artifact: run everything."
  fi
  if ! gh run download "$run" --repo "$REPO" --name tested-tree --dir "$dir"; then
    decide false "Run $run has no tested-tree artifact that could be downloaded: run everything."
  fi
  if ! recorded=$(jq -r 'if (.tree | type) == "string" and (.docs_only | type) == "string" then "\(.tree) \(.docs_only)" else error("not a tested tree") end' "$dir/tested-tree.json"); then
    decide false "Run $run's tested-tree artifact could not be read: run everything."
  fi
  read -r tree docs_only <<< "$recorded"
  if [ "$docs_only" != false ]; then
    decide false "Run $run recorded docs_only=${docs_only:-unset}; only a full run can stand in: run everything."
  fi
  if ! pushed=$(git rev-parse "$SHA^{tree}"); then
    decide false "git rev-parse $SHA^{tree} failed: run everything."
  fi
  if [ "$tree" != "$pushed" ]; then
    decide false "Run $run tested tree $tree, but $SHA has tree $pushed: run everything."
  fi
  decide true "Run $run of #$number tested tree $tree, the tree $SHA pushes: skip what it already ran."
}

case "${1:-}" in
  record) record "${2:-}" ;;
  decide) reuse ;;
  *)
    echo "usage: ci-tree-reuse.sh record <file> | decide" >&2
    exit 2
    ;;
esac
