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
`origin` only when Foreman or the workflow instructs it, and hand the operator the filled-in
handoff template from section 4. That push and document are the handoff: from then on the work
machine, the only one that can push to `teamupstart`, owns the port (publishing, CI, review
rounds as ordinary new commits, evidence, the fork record PR, close-out), and the personal
machine never touches the port again, except to replace a handoff before upstream's branch
exists, with a lease on the replaced commit: the one force-push allowed. The work machine records the open
proposal through a "Fork feature changes" `#### Upstream candidate` block in an empty-commit
record PR, never by editing the issue.
