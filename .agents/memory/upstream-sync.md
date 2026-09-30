---
category: repo-convention
date: 2026-09-29
source-session: upstream-sync ticket 1
times-confirmed: 1
---

# This repository is a fork: sync upstream only through the runbook

`origin` is `ramiro314/mission-control`, a fork of `teamupstart/mission-control` (`upstream`).
Bring upstream commits in only by following [docs/upstream-sync.md](../../docs/upstream-sync.md):
merge `upstream/main` into a fresh `sync/upstream-<date>` branch off `origin/main` (never rebase
or force-push), let upstream win conflicts, keep dependency versions equal to upstream's plus the
fork-only entries, and call `request_input` before removing or reworking any fork feature. The
human merges the sync PR. The fork's `Release` workflow is disabled in GitHub on purpose; leave
`release.yml` byte-identical to upstream's.
