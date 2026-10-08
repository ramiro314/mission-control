# Windows e2e failure inventory

The Windows e2e job's open causes and the ticket that owns each, for the D8 gate under D37
([plan](plan.md)). The first inventory, from run 37522217862, is in the description of PR #247.
This page records the re-measurement after the deterministic causes landed and replaces that
inventory's cause J ("unclassified"). Update it when a later run changes the picture.

## Re-measurement: run 37713823713

`release/windows` at `29efa258a`, after #252 (fake CLIs), #253 (8.3 paths), #256 (EPERM
teardown), #257 (`:` split) and #258 (`HOME` isolation). Source: the `windows-e2e-junit-shard-*`
artifacts and `playwright-report-windows-shard-3`.

- 1,160 tests: 699 passed, 143 failed, 165 errored, 153 skipped or not run.
- 3 of 14 shards (3, 4 and 14) hit the 30-minute global timeout, down from 4.
- Failures: 140 test timeouts, most while setting up `dashboard`; 39 `toBeHidden`, mostly a
  dispatch modal that never closes; 14 "daemon did not answer /api/health", 12 of them with an
  empty daemon log.

## What makes the daemon slow on win32

The machine is starved from the first test, and the daemon also stops answering in bursts.

- **The daemon stops answering.** In one trace, `/api/away` answers in 41 ms, then
  `/api/setup/checks` never completes, `/api/harnesses/models` takes 82 s, and every request
  started in the next minute ends at the same instant 78 s later. Nearly every stall in that
  shard opens with one of those two reads in flight.
- **Processes cost far more on the runner.** From the Windows unit JUnit in the same run: two
  real PowerShell process reads take 11.8 s; a test that starts Node children takes 6 s against
  0.7 s on Linux; a real daemon boot test takes 10 to 14 s against 2.6 to 4.7 s.
- **Every test started a dozen-process probe round three times.** `GET /api/setup/checks`
  forces a PATH re-read and runs every Setup probe at once. On win32 that is PowerShell, npm
  through `cmd.exe`, `reg` twice, `git`, `vswhere`, `python3` and four fake CLIs. The `daemon`
  fixture, the dashboard load and its reload each ran one.
- **Model discovery started refused harnesses.** The model catalog ran Codex's app-server and
  Pi's catalog probe on win32, where both harnesses are refused.
- **Process listings that could only be discarded.** win32 has no effective uid, so every
  system-wide process snapshot is unusable there. The SDK supervisor still took one, a
  PowerShell CIM query over every process, for each SDK session process, and worktree occupancy
  took one before refusing.
- **A false alarm every 30 seconds.** The managed-resume reconcile belongs to the terminal
  runtime, which win32 refuses. Its POSIX owner and mode checks cannot pass there, so every
  daemon logged a journal "requiring inspection" at boot and every 30 s.
- **A false leak warning at boot.** The Registry is a fan-out bus with about a dozen boot-time
  subscribers plus one per dashboard tab, so Node's default limit of ten warned on every boot.

Fixed on this ticket's branch: overlapping Setup reads share one probe round; model discovery
skips harnesses the host refuses; the supervisor and occupancy skip a listing they can only
discard; the managed-resume reconcile runs only where the terminal runtime does; and the Registry
carries a subscriber limit sized to its design. The spawn census on macOS for
`dispatch-backdrop-dismiss.spec.ts` went from 3.00 to 2.25 Setup rounds per test.

## Reclassification of cause J and `foreman-settings-tabs`

| Spec | Run 37713823713 | Owner |
|---|---|---|
| `action-rail`, `backlog-reorder`, `foreman-cheap-tier-default`, `foreman-planner-health`, `telemetry-primary-actions` | Pass | None; fixed by the deterministic causes |
| `file-line-comments`, `file-mermaid-preview`, `foreman-guide`, `foreman-invite`, `settings-standing-instructions` | Starvation only: dashboard setup timeouts, `ECONNRESET` | 69d2ed0c |
| `settings-task-sources-jira` | Starvation, except the Rovo check | 69d2ed0c; Rovo check 933eeb8a |
| `setup-banner-and-tour` | The Setup banner is absent after 20 s, the slow Setup read | 69d2ed0c |
| `workflows-tour` | Not run: shard 14 hit the global timeout | 69d2ed0c |
| `dispatch-restart-recovery` | Stale-ref fetch race: task seed answers 400 | 308298d4 |
| `library-exit` | Escape on a graph node leaves the wrong workflow | e1354b36 |
| `telemetry-settings` | Product analytics profile is not exporting | 88dc3820 |
| `foreman-settings-tabs` | Field explanations wrap under their controls: Windows font metrics | ba5ad02e |

## Open tickets

- c49c6d9c: the PATH read and npm script-shell probe without PowerShell and npm on win32.
- 69d2ed0c: re-measure after these fixes land, and clear what still times out.
- 308298d4, e1354b36, 88dc3820, 933eeb8a, ba5ad02e: the per-spec causes above.

The Windows CI shard timings ticket (8b370c3d) waits on all of them.
