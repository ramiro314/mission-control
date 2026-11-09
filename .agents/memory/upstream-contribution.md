---
category: repo-convention
date: 2026-11-09
source-session: upstream-contribution runbook
times-confirmed: 2
---

# Propose a fork feature upstream only through the runbook

Send a fork feature to `teamupstart/mission-control` only by following
[docs/upstream-contribution.md](../../docs/upstream-contribution.md): one upstream pull request
per feature, scoped by its `fork-feature` tracking issue's "Upstream candidate" section (ask
when it says no or maybe). Branch `upstream/<slug>` from `upstream/main` with `--no-track`,
never from fork `main`. Three-way apply each feature PR's diff, keeping only this feature's lines
in conflict regions, and check the result against fork `main`'s final state, with prerequisites
on other fork features stripped or replaced and every fork reference removed. Squash it into one
commit whose subject and body are the upstream PR's title and body (commit with `-F`, since an
editor strips the `#` headings). Under Mission Control, the Upstream Port Review workflow judges
only registered evidence, because the captured diff is measured from `origin/main`; push to
`origin` only when Foreman or the workflow instructs it, then hand the human the work-machine
commands: only that machine can push to `teamupstart` and open the PR. Review rounds amend the
commit and force-push the `upstream/*` branch, the one force-push allowed. Record the open
proposal through a "Fork feature changes" `#### Upstream candidate` block as soon as the human
reports the upstream PR number, in an empty-commit record PR when no fork PR touching the
feature is open, never by editing the issue.
