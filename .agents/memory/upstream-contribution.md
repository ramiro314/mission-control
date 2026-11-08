---
category: repo-convention
date: 2026-11-08
source-session: upstream-contribution runbook
times-confirmed: 1
---

# Propose a fork feature upstream only through the runbook

Send a fork feature to `teamupstart/mission-control` only by following
[docs/upstream-contribution.md](../../docs/upstream-contribution.md): one upstream pull request
per feature, scoped by its `fork-feature` tracking issue's "Upstream candidate" section (ask
when it says no or maybe). Branch `upstream/<slug>` from `upstream/main`, never from fork `main`,
and re-apply the feature's final state from fork `main` with prerequisites on other fork features
stripped or replaced and every fork reference removed. Squash it into one commit whose subject
and body are the upstream PR's title and body (commit with `-F`, since an editor strips the
`#` headings), push it to `origin` only, and hand the human the work-machine commands: only that
machine can push to `teamupstart` and open the PR. Review rounds amend the commit and
force-push the `upstream/*` branch, the one force-push allowed. Record the open proposal through a
"Fork feature changes" `#### Upstream candidate` block, never by editing the issue.
