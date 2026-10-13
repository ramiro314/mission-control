# Troubleshooting

Start with the symptom you can see. The linked feature pages are the authoritative
reference when you need the underlying behavior or configuration.

## The daemon will not start because port 7317 is already in use

Mission Control's daemon uses port 7317 by default. First run `make status` to see
whether the expected daemon already owns that port. It asks the daemon's `/api/health` for its
pid, so it reports "not running" when no daemon answers, even when some other program holds the
port. It needs `curl`, as `make up` and `make claude` do, and stops with "curl not found" rather
than guess when `curl` is missing. If this checkout started a
background daemon that you want to replace, run `make down`, then start the service
again. Use `make logs` when the daemon did not bind so you can see its startup error.

Do not casually start a second daemon on another port. The default port bind is also
not the state ownership boundary; a daemon with an isolated home and a different port can
still discover and write to the same local sessions. See
[Configuration](configuration.md) and [Skills and settings](skills-and-settings.md#the-daemon-is-no-longer-strictly-reactive).

## The daemon says the state home is already owned

Mission Control locks `$MISSION_HOME/daemon.lock` before it opens SQLite. The startup error
names the owning daemon's PID and API port. Stop that daemon if this start is meant to replace
it, or set `MISSION_HOME` to a genuinely independent state directory if both daemons are
intentional. Do not delete `daemon.lock`: the file is durable metadata, while the kernel-held
lock is the ownership authority and is released automatically after a crash.

The daemon exits with status 75 in this case. On Linux the `install-service` unit does not
restart on 75, so `systemctl --user status mission-control` shows it failed with
`status=75/TEMPFAIL` and `journalctl --user -u mission-control` holds the message. Once the other
daemon is stopped, `systemctl --user restart mission-control` starts it again.

The Linux desktop shell does not restart a daemon of its own that exits with 75: it adopts the
daemon that owns the state instead, and `daemon.log` says "another daemon owns this state;
adopting it".

## The desktop shell says the Mission Control service is not answering

On Linux the shell found the `mission-control` systemd user unit running, waited 30 seconds for
its daemon to answer `/api/health`, and gave up. It does not start a second daemon beside the
unit. `journalctl --user -u mission-control` shows why the unit's daemon is not answering; the
window loads as soon as it does. To run the shell's own daemon instead, stop the unit with
`systemctl --user stop mission-control`, then quit and reopen the shell.

## A launch fails with "Mission Control refused" a path

Each launch writes its wrapper script and disposable state home under
`mission-control-agent-state`, and scout credentials under `mission-control-agent-capabilities`.
Both live in `$XDG_RUNTIME_DIR/mission-control` on Linux and in the temp dir on macOS (see
`MISSION_AGENT_RUNTIME_DIR` in [Configuration](configuration.md)). Mission Control refuses a root
that is a symlink, is owned by another uid, or carries any group or other mode bits, because
another local user could then swap a launch wrapper or read a credential. It never falls back to
a different directory. The error names the path, its owner and its mode: check who created it,
remove it, and retry. Mission Control recreates it with mode `0700`.

## A launch fails because `XDG_RUNTIME_DIR` does not exist

On Linux the agent runtime roots live in `$XDG_RUNTIME_DIR/mission-control`. logind creates
`$XDG_RUNTIME_DIR` (usually `/run/user/<uid>`) at login and removes it when your last login
session ends, unless lingering is enabled. A daemon that keeps running after you log out, such
as one started in tmux over SSH, then loses every running agent's launch wrapper and state
home, and every later launch fails with "Mission Control cannot create ...: XDG_RUNTIME_DIR
(...) does not exist". Mission Control never creates that directory itself. Run
`loginctl enable-linger` so it survives logout, or set `MISSION_AGENT_RUNTIME_DIR` to a private
directory (see [Configuration](configuration.md)), then restart Mission Control.

## Focus or Open in says "No graphical session is reachable"

On Linux the daemon gives every window it opens a display from its own environment or the
systemd user manager's, and refuses when neither names a display whose socket still exists (see
[Linux display and process scopes](harnesses-and-terminals.md#linux-display-and-process-scopes)).
That happens after you log out with lingering on, or when the daemon was started outside any
desktop session, for example over SSH. Log in to a desktop session and try again. If you are
logged in and it still refuses, compare `echo $WAYLAND_DISPLAY $DISPLAY` in a desktop terminal
with `systemctl --user show-environment`: a desktop that does not import its environment into the
user manager needs `dbus-update-activation-environment --systemd WAYLAND_DISPLAY DISPLAY
XAUTHORITY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE` in its startup, or start the daemon from a
terminal in that session.

## `make init` says the native build tools are missing

The build compiles a small native module with node-gyp, so `make init` checks for a toolchain
before it starts anything long-running and stops with the command that fixes it. On macOS that is
`xcode-select --install`. On Linux it names what is missing among the C++ compiler (`CXX`, else
`g++`), `make` and `python3` (or `PYTHON`): install them with your distribution's package manager,
for example `build-essential python3` on Debian or Ubuntu, `gcc-c++ make python3` on Fedora, or
`base-devel python` on Arch, then rerun `make init`. `make init ARGS="--skip-build"` skips the check
along with the build.

## Worktree release or cleanup is refused because `lsof` is missing

The daemon asks `lsof` which processes are working in a worktree. Without it that answer is
unknown, and Mission Control refuses to release or clean up a worktree it cannot prove is idle.
macOS ships `lsof`; some Linux base systems, Arch's `base` among them, do not. `make init` stops
when it is missing, and **Settings → Setup → Runtime** shows a required **lsof** row. Install the
`lsof` package with your distribution's package manager, then press **Re-check**. The Makefile's
daemon targets ask `/api/health` instead; only `make stop-all` (and so `make restart`) still uses
`lsof`, to find Vite, and without it prints "lsof not found: stop Vite on :5173 yourself" and
leaves Vite running.

## The desktop shell aborts with a Chromium sandbox error on Linux

```
FATAL:setuid_sandbox_host.cc The SUID sandbox helper binary was found, but is not configured
correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that
.../node_modules/electron/dist/chrome-sandbox is owned by root and has mode 4755.
```

Chromium's sandbox needs unprivileged user namespaces. When the kernel or AppArmor restricts
them, as Ubuntu 24.04 and later do by default, Electron falls back to the setuid helper
`chrome-sandbox`, and `npm install` never makes that helper setuid root, so the shell
(`make desktop`, `make start`, or the [desktop entry](desktop-and-packaging.md#the-linux-desktop-entry))
aborts before its window opens. Arch and Fedora allow the namespaces, so this does not happen there.
Either allow user namespaces for Electron (on Ubuntu, an AppArmor profile granting `userns` to
`node_modules/electron/dist/electron`, or `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`
for the whole machine), or make the helper setuid root:

```sh
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

`npm install` replaces the helper whenever Electron is reinstalled, so the second fix has to be
repeated after an Electron upgrade. Do not launch the shell with `--no-sandbox`: the Electron
tests pass it because CI's runner restricts user namespaces, and that is the only place it is
sanctioned.

## The desktop shell or an Electron test cannot open a display on Linux

Electron exits at once with `Missing X server or $DISPLAY` when the shell or an Electron test
starts with neither `WAYLAND_DISPLAY` nor `DISPLAY`: over SSH, in a container, or from a terminal
that is not inside the desktop session. Start the shell from a desktop session. For the tests, run
them under a virtual display, as CI does:

```sh
xvfb-run -a npm test
xvfb-run -a npm run test:e2e
```

Windows the daemon opens for Focus and **Open in** are a different path with their own message;
see [Focus or Open in says "No graphical session is reachable"](#focus-or-open-in-says-no-graphical-session-is-reachable),
which also covers `dbus-update-activation-environment --systemd` for a desktop that does not hand
its display to the systemd user manager.

## Mission Control stops when you log out of Linux

The `install-service` unit runs under your systemd user manager, which by default stops when your
last login session ends. That stops the daemon, and with it the tmux and Herdr servers Mission
Control started and the agents inside them, which matches macOS, where logout ends the
LaunchAgent. To keep them running after logout, enable lingering:

```sh
loginctl enable-linger
```

With lingering on, the unit and those servers keep running and `$XDG_RUNTIME_DIR` survives, but
the desktop's display goes away with the session, so Focus and **Open in** fail with "No graphical
session is reachable" until you log in to a desktop again. A daemon started with `make start` or
`npm run dev` belongs to the terminal that started it and stops with it either way.

## Old headless transcripts remain in `~/.claude/projects/-tmp/`

On Linux, Mission Control's one-shot model runs used to start in `/tmp`, so Claude filed their
transcripts in `~/.claude/projects/-tmp/`, beside those of any session you started from `/tmp`.
They now run in `~/.mission-control/headless`, and the daemon prunes only that directory's
transcripts. It never touches `-tmp` again, because it cannot tell its old files from yours there.
Remove what you do not want by hand; nothing in Mission Control reads them (see
[Models](models.md)). macOS is unaffected: its runs use the per-user temp dir as before.

## A Claude session stays grey, or its status looks stale

`instrumented: true` means the daemon has fresh hook evidence for that session. Install
the Claude integrations from a durable checkout with `npm run install-hooks`, then start
a new Claude Code session. Claude reads its hook configuration when a session starts, so
an already-running session will not begin reporting until it is restarted. In the new
session, run an action and confirm the card changes to **working**; the session endpoint
also exposes the `instrumented` field.

If `~/.claude/settings.json` runs the hook shim and `~/.mission-control/bin/harness-hook` is
missing or not executable on this machine, every hook exits without reporting and nothing
prints an error. The **Claude Code hooks** row in Settings -> Setup says so; re-run
`npm run install-hooks` to write the shim again.

Codex differs: its hooks are launch-scoped, so only a Mission Control-dispatched Codex
session receives them. See [precise session status](sessions.md#precise-status-claude-hooks) and
[the Codex hook behavior](sessions.md#precise-status-for-codex-hooks-that-ride-on-the-dispatch).

## Every Claude turn prints a hook error with `MODULE_NOT_FOUND`

```
UserPromptSubmit hook error
Error: Cannot find module '/Users/you/workspace/ai-harness/hooks/harness-hook.mjs'
code: 'MODULE_NOT_FOUND'
```

The desktop app's **Install Claude integrations** bakes an absolute path into
`~/.claude/settings.json`, and `npm run install-hooks` bakes one into the shim
`~/.mission-control/bin/harness-hook` that the settings file runs (older versions wrote it
into the settings file directly). The path does not follow a checkout that is
later renamed, moved, or deleted, so Claude Code goes on running it for every event, in
every session on the machine, and every one of them fails. Nothing in the stack names
Mission Control or the settings file, and the sessions report no state while it lasts.

Mission Control reports this itself rather than leaving you to read the stack. The
**Claude Code hooks** row in Settings -> Setup names the dead path and how many events run
it, the setup banner raises it as a required gap, and the Dispatch form repeats the note
before an agent goes out on the machine.

The fix is to re-run the installer from a checkout that still exists:

```sh
cd <your durable clone> && npm run install-hooks
```

Run it from a durable clone rather than a pooled worktree. An install from a pool slot
bakes a path the pool will reclaim, which is this same outage with a shorter fuse, and the
installer refuses one outright for that reason. Packaged-app users press **Install Claude
integrations** instead; either installer now replaces the other's entries rather than
stacking a second bridge beside them.

## Playwright cannot find Chromium

If the end-to-end run reports `browserType.launch: Executable doesn't exist`, install
the browser once on this machine:

```sh
npx playwright install chromium
```

Then rebuild before rerunning the suite. The end-to-end tests drive `dist/`, not source:

```sh
npm run build
npm run test:e2e
```

See the [browser end-to-end test guide](../e2e/README.md).

## iTerm2 is installed but sessions are missing or actions are denied

iTerm2 runs on macOS only; on Linux it is shown disabled with **requires macOS** and has no
Setup row.

First confirm iTerm2 is open. Mission Control intentionally does not address a closed iTerm2
during Setup or discovery because AppleScript application addressing would launch it. If the
app is open, inspect **System Settings → Privacy & Security → Automation**, expand Mission
Control or the terminal host that started a source daemon, and enable its **iTerm2** toggle.
Then retry the action or use **Settings → Setup → Re-check**.

If access was denied, the Automation entry is missing, or you need to revoke or reset access,
follow [iTerm2 Automation and permission recovery](sessions.md#iterm2-automation-and-permission-recovery).

## The end-to-end suite has no build to serve

Run `npm run build` before `npm run test:e2e`. The daemon used by the suite serves the
built dashboard from `dist/`; without that build it cannot serve the application the
browser tests exercise. The required command order is in the [browser end-to-end test guide](../e2e/README.md).

## A scout or ensemble dispatch is refused, or the daemon says the MCP bundle is behind

Run `npm run build` (or just `npm run build:mcp`).

Symptoms, all of which are the same cause:

- The daemon logs at startup:
  `[mission-control] Mission Control's MCP server at …/dist/mcp/server.mjs does not publish submit_scout_artifacts …`
- A scout or ensemble dispatch fails with `this claude session requires the Mission MCP tools
  …`, or assigning a scout is refused before its checkout is reset.
- `npm run smoke` fails with `MISSION_MCP_TOOLS declares … which the MCP bundle does not publish`.

Dispatched agents are handed the **built** `dist/mcp/server.mjs`, never `src/mcp/server.ts`.
That file is rebuilt only by `npm run build` and is gitignored, so a `git pull` that brings you
a new MCP tool never brings you a bundle that serves it - and `npm run dev` reloads the daemon
from source without touching the bundle. The refusal is deliberate: a scout that cannot call
`submit_scout_artifacts` can never mark its task **done**, so failing the launch is better than
an agent that finishes its work and has nowhere to put it. See [Adding or changing a tool means
rebuilding the bundle](sessions.md#review-channel-mcp).

## A legacy Treehouse task or check cannot clean up

New work never needs Treehouse. A cleanup error naming provider `treehouse` refers to a persisted
resource from an older Mission Control. Run `treehouse status --json` in the recorded repository
if the binary is available. Mission Control conditionally returns only a v2.1.1+ lease whose
persisted lease ID, path, and holder still match and whose checkout is clean and unoccupied.

A missing or older binary, null lease ID, changed identity, foreign lease, dirty checkout, or
uncertain occupancy keeps the row and worktree intact. Resolve unverifiable or foreign resources
with Treehouse itself after confirming their current owner. Do not convert them to Git worktrees or
delete their directories behind Treehouse's bookkeeping. See
[Legacy Treehouse compatibility](worktrees-and-checks.md#legacy-treehouse-compatibility).

**Settings > Worktrees > Treehouse** shows the same provider reading with its exact
classification. An exact row offers a preview-first Return only when durable owner identity,
cleanliness, and empty occupancy all agree. Unverifiable, foreign, and unreadable rows show
remediation instead of a Force button. Treehouse can be removed after that section reports no
durable legacy rows and you have separately reviewed every foreign lease.

## A Worktrees action says the preview is stale

Nothing was changed. A short-lived preview is bound to the exact owner, slot version, Git and
process observations, and fixed target set it displayed. Refresh the preview and review the new
facts. This commonly happens when a task finishes, a process exits, Git state moves, another
dashboard changes policy, or reconciliation repairs a slot between preview and Execute.

An unknown-process blocker is different: it cannot be acknowledged. Restore the host's process
inspection, stop the owning task or check through its normal control, and use **Reconcile**. Do not
delete the directory or Git registration by hand; uncertainty is why Mission Control kept it.

## A session says exited but its task or workflow has not settled yet

**Exited** is the temporary presentation state at the start of session eviction, not the
durable cleanup boundary. The Registry waits through its linger window and then publishes
`session_remove`; tasks, workflows, reviews, and drafts reconcile from that removal event.
For a dispatched task, the session's disappearance normally settles the task after that
eviction path, while preserving its worktree for an explicit cleanup or re-dispatch.

Wait for removal before treating the session as fully gone, then inspect the task row for
its recorded outcome and cleanup choice. See [session lifecycle](session-lifecycle.md#from-observation-to-removal)
and [when a task's agent goes away](dispatch-and-backlog.md#when-a-tasks-agent-goes-away).

## Resource protected by organization SAML enforcement

GitHub refused a call because the repository it named belongs to an organization that enforces
SAML SSO, and your gh token is not authorized for that organization. Mission Control reports
this as one sentence instead of gh's raw GraphQL line: the repository it tried, the
organization that refused, gh's "Authorize" link, and what to change. Following the link
authorizes the token for that organization, which is your choice and happens outside Mission
Control. The rest of this entry is for when you did not mean to reach that organization at all.

**Which repository was tried.** Mission Control never lets `gh` choose a repository. Left to
choose, `gh` prefers a remote called `upstream`, which in a fork checkout is the parent. Every
call names one, resolved from the checkout: its gh default pin (`remote.<name>.gh-resolved`,
which `gh repo set-default` writes) when the pin names a GitHub remote, otherwise `origin`. See
[which repository a source names](dispatch-and-backlog.md#which-repository-a-source-names).

**The pin.** In a checkout with more than one GitHub remote and no pin, Mission Control pins
gh's default to `origin` itself, so bare `gh` calls from agents and your terminal stop
reaching the parent too. It never overwrites a pin you set. A pin on another remote therefore
wins, and the message says so, for example "GitHub refused `owner/name` (this checkout's gh
default pin, not origin)". Run `git config --get-regexp 'gh-resolved$'` in the checkout to see
the pin. See [Mission Control pins gh's default repository to
origin](dispatch-and-backlog.md#mission-control-pins-ghs-default-repository-to-origin).

**What to change, by surface:**

- **A GitHub issues task source**: its sweep, **Check it works**, **Create GitHub issue**,
  write-back and linked-issue reads. "To use your fork instead, set Repository on this source
  or pin `gh repo set-default`." A filled-in **Repository** is used as written. A blank one
  follows the pin, so `gh repo set-default <your fork>` in the checkout moves it. A write-back
  or linked-issue read whose issue names its own repository, by its `owner/repo#123` id or its
  URL, goes to that repository whatever Repository or the pin say, so its message offers only
  the authorize link.
- **Product reports** from the Feedback form: "Forks: set `MISSION_PRODUCT_ISSUES_REPO`." See
  [Configuration](configuration.md).
- **The updater** and `scripts/install-app.mjs`: updates always come from
  `teamupstart/mission-control`, so the only remedy is authorizing the token.
- **The GitHub Inspector**: the pull request's URL names its repository, so no remedy is
  offered beyond authorizing.
