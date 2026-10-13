# First-run setup

This walkthrough takes a new checkout from clone to a running Mission Control and
its full verification suite. For the contributor expectations and test policy, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

If you are installing Mission Control to use rather than to work on, read the illustrated
[setup guide](setup-guide.html) instead. It covers the same Setup panel from the operator's
side, with screenshots, a required-versus-optional breakdown of every row, and how updates
arrive.

## Platform support

Mission Control runs on macOS and Linux. Linux runs from a source checkout: there is no packaged
Linux app. A feature either works on both, or the Linux column says what replaces it or that it
is unavailable there. Windows is not supported.

| Feature | macOS | Linux | How to get it on Linux |
| --- | --- | --- | --- |
| Dashboard in a browser | Yes | Yes | `make init`, then `npm run dev` (or `npm run build && npm start`) |
| Packaged desktop app (`make install`, `make app`, `make install-app`, the Bash installer, `npm run package`) | Yes, Apple Silicon | No | Run from a checkout. These commands refuse Linux with "The packaged app is macOS only" |
| Updates | In-app updater | No updater | `git pull && make build` |
| Database recovery (`npm run recover:database`) | Yes | No | Packaged app only; refused on Linux |
| Desktop shell (Electron) | Packaged app, or `make desktop` | Yes | `make desktop` or `make start` from a checkout, or `make desktop-entry` for the built shell in the app menu ([desktop entry](desktop-and-packaging.md#the-linux-desktop-entry)) |
| Window frame and menu | Hidden title bar, macOS app menu | Window manager's frame; <kbd>Alt</kbd> shows the menu bar | Nothing to do |
| Tray, and closing the window to hide it | Menu bar | Where a StatusNotifier host runs (KDE Plasma does, stock GNOME does not) | Without a tray host, closing the window quits; **Settings → Setup → Integrations** replaces the tray's integration items ([closing the window](desktop-and-packaging.md#closing-the-window)) |
| Shell **Start at login** | Login item | XDG autostart entry | `make desktop-entry` first; until then the checkbox is disabled |
| Always-on daemon (`npm run install-service`) | LaunchAgent | systemd user unit | Stops at logout unless you run `loginctl enable-linger` ([always-on](overview.md#quick-start)) |
| Keep Awake | IOKit idle-sleep assertion | `systemd-inhibit --what=idle:sleep` | Needs `systemd-inhibit`; without it the switch reports unavailable |
| Shortcuts | <kbd>⌘</kbd> is Command | <kbd>⌘</kbd> is <kbd>Ctrl</kbd>; keycaps read Ctrl | **Reset checkout** (<kbd>⌃</kbd><kbd>R</kbd>) has no default key; bind one in **Settings → Keyboard** ([shortcuts](ui.md#keyboard-shortcuts)) |
| tmux, Herdr, WezTerm | Yes | Yes | Install them; Setup names the package or links each one's install guide |
| Ghostty | Full adapter (hosts agents, Focus) | Spawn only: opens Focus windows, never hosts an agent | `ghostty` on `PATH` |
| cmux, iTerm2 | Yes | No | Shown disabled with **requires macOS**; use tmux or Herdr |
| Default terminal (`xdg-terminal-exec`, then `$TERMINAL`) | Not offered | Opens Focus and new-session windows, never hosts an agent | Install `xdg-terminal-exec` or set `TERMINAL` |
| Focus and **Open in** windows | Yes | Yes, from a graphical session | A daemon under the systemd unit reads the user manager's display; see [Linux display and process scopes](harnesses-and-terminals.md#linux-display-and-process-scopes) |
| Setup remedies | Homebrew commands with **Run in a terminal** | Package names for your distribution, no **Run in a terminal** | `npm install -g` rows (Claude Code, Pi) run on both |
| `lsof` | Ships with the OS | Required, not always installed | Install the `lsof` package; `make init` and Setup check for it |
| Native build toolchain | Xcode command line tools | C++ compiler, `make`, `python3` | For example `build-essential python3` (Debian, Ubuntu) or `base-devel python` (Arch) |
| Headless model runs' directory | Per-user temp dir | `~/.mission-control/headless` | Nothing to do; old `~/.claude/projects/-tmp/` transcripts can be [removed by hand](troubleshooting.md#old-headless-transcripts-remain-in-claudeprojects-tmp) |
| Electron tests (`npm test`, `npm run test:electron`) | Yes | Yes, with `--no-sandbox` | Run under `xvfb-run -a` when there is no display |

## Prerequisites

After Mission Control is running, open **Settings → Setup** for the machine-wide view of
agent CLIs, terminal backends, GitHub CLI authentication, agent extensions,
ai-conductor, and the system Node.js runtime.

The panel opens with a verdict for the whole machine - whether it can run sessions, how many
checks are ready, and whether any gap is a required one - above a rail of dependency families.
One family is read at a time: the rail carries each family's ready count and marks the ones
with gaps, and the pane beside it holds that family's rows. It opens on the family holding a
required gap, then any gap, and stays where you put it - a **Re-check** that repairs the
family you are reading reports into that family rather than moving the rail. A satisfied row
shows its name, the path or evidence Mission Control found, and the source of an executable
path, such as inherited PATH, login shell, operator override, version-manager location, or
project-local node_modules.
Paths are written relative to your home directory, with the absolute path on hover. Missing rows explain what capability is
unavailable and provide a documentation link or copyable command. A runnable package-manager remedy also offers **Run in a terminal**:
choose an available backend and Mission Control opens a visible terminal running the catalog's
fixed command. The daemon owns the argv, working directory, title, and hold-open shell; the
browser sends only the dependency id and terminal backend. The terminal remains open after the
command exits so you can read its exit code, then use **Re-check** to inspect the machine again.

Remedies follow the host. On macOS a missing tmux, WezTerm, Ghostty, GitHub CLI or Node.js offers
its Homebrew command. Linux has no single package manager to name, so the same row shows the
package to install, "with your distribution's package manager", and a link to the tool's install
guide, with no **Run in a terminal** button. The `npm install -g` rows (Claude Code and Pi) run on
both. Rows for a terminal backend the host cannot run at all, iTerm2 and cmux on Linux, are left
out of Setup rather than reported as needing setup; the terminal pickers still list them,
disabled with **requires macOS**. An installed Ghostty or WezTerm reads as satisfied on Linux.
Every read probes the machine afresh, except that a read arriving while another is still
probing - a second tab, a reload, or **Re-check** pressed mid-round - shares that round's result
instead of starting a second set of probes. Each read still gets its own snapshot for dismissal.

Pi's **Agent SDK** runtime is unlocked only when Setup reports two ready rows: the global Pi
CLI in **Agent CLIs** and the Mission Control Pi extension in **Agent extensions**. The Pi CLI
row offers `npm install -g @earendil-works/pi-coding-agent` through **Run in a terminal**; the
extension row offers **Install Pi integration** on a first install. After both complete, use
**Re-check**, then choose Agent SDK under **Settings → Harnesses**. If either prerequisite is
missing or unhealthy, that runtime option remains disabled.

The **Agent extensions** family offers **Install Pi integration** on first use and
**Repair Pi integration** for an owned unhealthy installation. The app copies its bundled
integration into its state home, verifies hashes, loads it in a bounded child, and checks real
MCP tool discovery before publishing Pi's link. No clone, npm command or terminal is required.
Start a fresh Pi session afterward. Enabled integration updates reconcile on daemon startup;
old generations remain available to running sessions. Foreign entries stay untouched and need
their owner to move them. **Re-check** reports current health without changing files. A machine
that never installed Pi integration has no required Pi warning.

When the UpstartClaw core plugin is installed, this family also keeps an **UpstartClaw core
setup** row visible. A completed setup reads **Ready**; missing, unfinished, malformed, or
unreadable setup state reads **Needs setup** and offers the interactive setup skill command.
The row links to [Running Mission Control at Upstart](upstart.md), which includes the marketplace,
plugin installation, sign-in, restart, daemon certificate, and verification steps. Machines
without the plugin remain free of Upstart-specific setup chrome.

The **Runtime** family checks the selected system **Node.js**, using the same minimum as the
installer and update preflight (currently Node.js 24). It reports a missing or older runtime as
**Needs setup**, and failed or unparseable version probes as **Unknown**. On macOS,
**Run in a terminal** opens `brew install node` in the selected visible terminal to install or
update Node.js and npm. This command requires Homebrew; if you manage Node another way, select a
supported version in that manager instead. On Linux the row names the `nodejs` package for your
distribution's package manager, or a version manager, and runs nothing. Read the command's exit status, then press **Re-check**. Opening the
installer alone never marks Node ready. If `MISSION_NODE_BIN`, a version manager, or inherited
PATH still selects an older runtime, correct that selection and restart Mission Control with
the corrected environment. The updater still performs its fuller Node/npm checks in the build
directory before preparing an update.

On Linux the **Runtime** family also has a required **lsof** row. A missing `lsof` names the
package for your distribution's package manager and runs nothing. macOS ships `lsof`, so the row
is not shown there.

The Herdr row reports two separate facts, because installing the CLI does not make Herdr usable.
With the `herdr` binary present but its default server stopped, the row is **Needs setup** and
offers **Start the Herdr server** instead of the installation guide. That button opens no
terminal: the daemon starts the server the same way a dispatch to Herdr would, waits for it to
answer, and the panel re-reads the machine on its own, so a repaired row reports Ready without a
manual **Re-check**. A Herdr older than the supported release is reported with its compatibility
reason and is not offered a start, because starting it repairs nothing. While the server is down,
discovery simply sees no Herdr workspaces and logs nothing.

The cmux row reports three facts for the same reason, and two of them are not installation.
cmux's control socket exists only while its **app is running**, and cmux ships
`automation.socketControlMode: "cmuxOnly"`, which admits only processes started inside cmux -
the daemon is not one, so with the default every call it makes is denied. Under either fault the
adapter simply sees no cmux workspaces, which is why the row used to read Ready on the strength
of the binary alone while every dispatch to cmux failed. A closed app is **Needs setup** and
offers **Open cmux**, which opens the app and waits for its socket to answer. A refusing socket
is **Needs setup** and offers **Allow Mission Control to drive cmux**, which sets that one value
to `allowAll`, copying `~/.config/cmux/cmux.json` to a timestamped `.bak` first when there is
already a file to copy - a machine with no cmux config yet gets one written and nothing is backed
up. Your comments and every other setting are left alone, and a file that does not parse is
refused rather than replaced. No reload is needed - cmux watches the file - and no reload would be
possible anyway, since `cmux reload-config` is one of the calls the default refuses. A satisfied
row reports the mode it read, as `(socket control allowAll)`.

The optional iTerm2 row, shown on macOS only, uses the same `/Applications/iTerm.app`, `~/Applications/iTerm.app`, or
configured `ITERM_BIN` filesystem
check as launch targeting. It never starts iTerm2 while reading Setup. The copyable remedy is
`brew install --cask iterm2`; Automation permission is requested only when an already-running
iTerm2 is controlled or when you explicitly launch through it. See
[iTerm2 Automation and permission recovery](sessions.md#iterm2-automation-and-permission-recovery).

Package installers never run inside the daemon. Provider installers such as
ai-conductor additionally require the daemon to resolve exactly one checkout from its verified
workspace candidates, then reverify that candidate when the button is pressed. If there is no
verified checkout, or more than one, Setup links to **Settings → Conductor** instead of offering
a button that must fail or guess.

Mission Control also puts a dismissible reminder above the dashboard on first launch, or when
a required Setup row becomes missing or needs setup. **Open Setup** links directly to this panel.
Dismissal is stored on this machine. A repaired row retires its acknowledgement, so the reminder
returns if that required capability later regresses. An inconclusive **Unknown** result does not
raise the reminder. A dismissal is bound to the required rows in the checks result it came from;
if another tab observes repair or regression first, the stale dismissal is refused and asks the
operator to re-check.

The **Set up this machine** guided tour shows you how to reach this panel and what to do with
it, then continues into **Trust**, in seven stops: the ⚙ gear, **Setup** in the Settings rail,
the dependency list where you install the tools you will use, **Re-check** to confirm they
took, then **Trust** in the rail, its repository-by-grant matrix, and the row that adds a
repository to it. It runs once automatically on a fresh profile, and can be started again from
**Help & tours** at the bottom of the Settings rail or from **Start Set up this machine tour**
in the command palette. It executes no remedy and clicks no grant, and it leaves you on Trust
rather than returning you to the page you started from. See
[Trust](skills-and-settings.md#trust-who-may-act-in-which-repository) for what each column
permits.

Install Node.js 24 or newer and verify it:

```sh
node --version
```

The build compiles a small native module with node-gyp, so it also needs a C++ toolchain: the
Xcode command line tools on macOS (`xcode-select --install`), or a C++ compiler, `make` and
`python3` on Linux (for example `build-essential python3` on Debian or Ubuntu, `base-devel
python` on Arch).

On Linux, also install `lsof`, which some base systems (Arch's `base`, for one) leave out. The
daemon uses it to see which processes are working in a worktree; without it that answer is
unknown, so worktree release and cleanup are refused. macOS ships it.

On Linux, install tmux or Herdr too if you want terminal-runtime agents. Ghostty and the
desktop's default terminal only open windows there, so an agent that runs in a terminal lives in
tmux, Herdr or WezTerm.

Browser tests also need Playwright Chromium once per machine. `npm install` does not
download it, so install it explicitly when you need e2e coverage:

```sh
npx playwright install chromium
```

On Linux, Chromium also needs system libraries that a desktop install usually has and a minimal
or container install may not. On Debian or Ubuntu, `npx playwright install --with-deps chromium`
installs them through apt; on other distributions, install the libraries Playwright names when
it fails to launch.

## Bootstrap the checkout

```sh
git clone https://github.com/teamupstart/mission-control.git
cd mission-control
make init
```

`make init` is safe to repeat. It installs npm dependencies, builds the application,
and merges the Claude status hooks
into `~/.claude/settings.json` without replacing your other hooks. To validate the
browser prerequisite as part of bootstrap, run:

```sh
make init ARGS="--with-e2e"
```

The init command checks the Node version before it changes the checkout, checks for that
native build toolchain unless `--skip-build` is given, checks for `lsof` on Linux, and checks for Chromium before build and
hook setup when `--with-e2e` is requested. Each failed
check prints the command that fixes it. `make setup` runs the same dependency, build, and hook
steps without the prerequisite walkthrough.

## Run Mission Control

```sh
npm run dev
```

This starts the daemon and Vite dashboard. Open `http://127.0.0.1:5173`. To run the
desktop shell too, use `npm run dev:desktop`; `npm run dev:start` also starts Foreman.

On Linux this checkout is the install: there is no packaged Linux app, and updating is
`git pull`. The packaged-app commands, which `make help` marks `[macOS]` (`make install`,
`make app`, `make install-app`), plus `npm run package`, the Bash installer and
`npm run recover:database`, refuse Linux before they start work. Each prints "The packaged
app is macOS only; on Linux run from a checkout (see docs/setup.md)." Settings -> Setup
shows the same line in place of updates.

To launch the desktop shell from the app menu instead of `npm run dev:desktop`, run
`make desktop-entry`. It builds the bundles and installs a desktop entry that runs this
checkout's Electron against them with no dev server; update it with `git pull && make build`.
See [The Linux desktop entry](desktop-and-packaging.md#the-linux-desktop-entry).

The daemon's default state directory is `~/.mission-control`. It contains the SQLite
database, token, logs, native worktree pools, disposable worktrees, and the
[archive library](archives.md). Set
`MISSION_HOME` to use a separate state root; [configuration.md](configuration.md) documents
that and the other runtime settings. `make db` opens the active database in a read-only
shell.

The Claude status hooks installed by `make init` take effect for sessions started
after installation. Re-run `npm run install-hooks` after changing hook configuration.

Install them from a durable clone. The installer writes absolute paths into
`~/.claude/settings.json`, and those paths do not follow a checkout that is later renamed
or removed: every Claude session on the machine then fails every hook event with
`MODULE_NOT_FOUND`. Settings -> Setup carries a **Claude Code hooks** row that names a dead
path when one appears, and
[troubleshooting.md](troubleshooting.md#every-claude-turn-prints-a-hook-error-with-module_not_found)
covers the repair.

## Verify the checkout

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

The e2e suite drives the built dashboard and built daemon, so build first. It uses
fake agents and does not spend model tokens. See [e2e/README.md](../e2e/README.md) for
focused commands, traces, and its isolation rules.

## Explore without real agent sessions

After building, launch the isolated demo:

```sh
npm run demo
```

Demo mode uses `~/.mission-control-demo` rather than your normal state directory and
replaces agent binaries with local scenario players. `npm run demo -- --fresh` rebuilds
and seeds a populated demo fleet; it takes longer because it drives real application
routes. See [demo-mode.md](demo-mode.md) for its flags and boundaries.

To regenerate the committed README imagery after a dashboard change, first run
`npx playwright install chromium` once on a new machine, then build and run
`npm run docs:screenshots`. The capture tool uses its own disposable demo state root, fixed
viewport, and local scenario players, so it does not use agent models or alter your normal demo.
