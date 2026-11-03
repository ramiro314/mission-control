# Session History

**History** is a top-level page that lists every agent session this machine holds on disk,
whether or not Mission Control ever launched or saw it. Open it from the title bar, with
<kbd>h</kbd>, or at `#/history`. The design and its later stages are in
[the session history plan](plans/session-history/plan.md).

Claude Code is the only agent with a history reader today. Codex and Pi declare none, so their
sessions do not appear yet.

## The list

- **Order.** All time, newest activity first, grouped by day, 50 rows a page with **Load
  more** for older ones.
- **Conversations by default.** The list shows interactive, SDK and unclassified sessions.
  One-shot and reviewer runs, which are most of what Mission Control's own background work
  leaves behind, are listed only when the **Kind** filter asks for them.
- **Title.** The session's custom title, else its AI title, else its first prompt.
- **Row.** Repository (or the raw cwd when no repository was resolved, with the full cwd on
  hover), branch, kind, model, cost and duration.
- **Transcript gone.** When Claude Code's retention (`cleanupPeriodDays`, 30 days by default)
  deletes a transcript, its row stays and carries a **Transcript gone** badge. Rows are never
  deleted.
- **Retention header.** "Claude Code keeps transcripts for N days", where N is
  `cleanupPeriodDays` from `~/.claude/settings.json` (30, Claude Code's default, when it is
  unset or not a whole number of at least 1), linked to
  [the setting's documentation](https://code.claude.com/docs/en/settings-reference#cleanupperioddays).
  Only the user settings file is read, because the header speaks for every project. Mission
  Control never edits the setting.
- **First run.** The catalog fills in the background after the daemon starts. While it does,
  the page reads "Indexing N of M sessions" and the rows appear newest first as they are
  indexed. While that line is showing, the page re-reads the catalog a second after each answer
  lands, so a slow read is never cut off by the next one.
- **Live.** An open page updates within seconds, without a reload, when a session starts or
  grows: its title, last activity and cost follow the transcript. The page does not poll for
  this. It re-reads the rows on screen when the daemon announces a change, and once each time
  the dashboard's event stream reconnects. A re-read keeps every row already loaded, so a new
  session at the top never pushes the oldest one back behind **Load more**, and a change that
  arrives while Load more is loading is applied once that page lands.

## Search and filters

Every control lives in the page's URL (`#/history?q=&repo=&from=&to=&kind=&agent=`) and
replaces the route as it changes, so a filtered list survives a reload and can be shared,
and refining it leaves no trail of entries for Back. A value this build would refuse (an
unknown kind, an impossible day) is dropped from the URL rather than sent.

- **Search** waits for typing to settle, then matches a literal, case-folded substring against
  each session's titles (custom, AI and first prompt), cwd, repository, branch and indexed user
  prompts. It narrows the list without reordering it.
- **What is indexed.** A conversation indexes every user prompt, up to 16,000 characters each.
  A one-shot or reviewer run indexes only its first prompt, capped at 500 characters, because
  its prompts are large generated diffs. A compaction summary, which Claude Code records as a
  user message, is Claude's own words and is not indexed. User prompts are therefore copied into `harness.db`;
  see [security](security.md#session-history-copies-user-prompts-into-harnessdb).
- **Repository** lists every repository a session resolved to (see Repository below), so the
  slots of one worktree pool appear once, as their repository.
- **From** and **To** are local calendar days, both inclusive, bounding last activity.
- **Kind** is Conversations by default; **All kinds** adds one-shot and reviewer runs, and a
  single kind narrows the list to it.
- **Agent** appears only once a second harness has a history reader. Today only Claude has one,
  so it is hidden.
- **Clear filters** drops every filter and keeps the search words.

## A session

Select a row's title, or open `#/history/claude/<id>`, to read one session. **← History**
returns to the list as it was, with its search and filters and the rows already paged to:
the detail's URL carries the list's filters (`#/history/claude/<id>?q=&kind=`). A deep link naming an agent
this build does not know, or an id that is not a UUID, lands on the list; a well-formed id
History has not indexed says so.

- **Header.** Title, kind, repository, branch, working directory, model, start and last
  activity, duration and cost, each shown when the transcript recorded it.
- **Conversation.** The session's messages, rendered by the same component the live
  conversation panel uses (`ConversationMessages` in `TranscriptPanel.tsx`), read from the
  transcript on disk from the top. **Load more messages** reads the next window. It is
  read-only: there is no composer.
- **Tool calls.** Under each turn that called tools, every call opens to its whole input (up to
  256 KB, where the live view cuts at 1,800 characters) and its result, read only when the call
  is opened. A result Claude Code moved to a `tool-results/` sidecar file is read whole from
  that file. Either is cut at 1 MB of UTF-8, on a character boundary. A call with no recorded
  result, or whose sidecar file is gone or not reachable, says **Result unavailable** and why.
- **Compaction.** Where Claude Code compacted the context, a divider reads "Context compacted"
  with its trigger and the token count before it. The summary Claude carried past it is
  folded under **Summary carried past the compaction**, not drawn as the operator speaking.
- **Subagent runs.** Listed above the conversation, labelled by type and description (or
  opening prompt). Each opens its own transcript in place, paged with **Load more subagent
  messages**. Its prompts are bylined as delegated from the parent session. A subagent's own
  tool calls show their input; their results are not read here.
- **Launch context.** The second tab: what the session was launched with, as its transcript
  recorded it, parsed on demand and never copied into the catalog. Each section lists what was
  recorded, or says **Not recorded** when the transcript holds no record of it. A missing record
  is never read as "none": Claude Code writes no `instructions` record both when a session
  loads no files and when `--setting-sources` restricts them.
  - **Instruction files.** CLAUDE.md, AGENTS.md and memory files from `instructions`
    attachments, each with its path, scope (`User`, `Project`, `AutoMem`), why it loaded
    (`session_start`, `compaction`) and its text as that session loaded it, which may differ
    from the file today. A file reloaded unchanged for the same reason is listed once.
  - **Standing instructions** and **Appended system prompt**, from `prompt_snapshot.systemPrompt`.
    Mission Control's standing-instructions block is recognized by its heading; every other
    appended block is listed after it.
  - **Skills.** Available, from `skill_listing`; used, from the `Skill` tool, `attributionSkill`,
    `invoked_skills`, and slash commands that name a listed skill.
  - **MCP servers and tools**, from `deferred_tools_delta`, `mcp_instructions_delta` and the
    snapshot's tool list: each server's latest status (connected, pending, needs
    authentication, failed), the instructions it sent, and the MCP tools offered.
  - **Environment.** Working directory, branch, git status at launch, worktree and repository
    flags, additional directories, platform, model, effort and permission mode, all from the
    session's own records: a subagent's records and attachments never set them. The account
    email Claude Code records beside the git status is not served.
  - **Hooks** that ran (`stop_hook_summary`, `hook_cancelled`), grouped by event and command
    with their run count, total and longest duration, and how many failed. A failed run is a
    cancelled one, or one whose summary recorded `hookErrors`: a summary of one hook charges
    its errors to that hook, and a summary of several charges only a hook whose command an
    error names.
- **Transcript gone.** The header stays, with the **Transcript gone** badge, and both tabs say
  the transcript was removed by Claude Code's retention.
- **Live.** A session the Registry is running carries a **Live** badge in the list and in its
  detail, and the detail offers **Open in Fleet**, which selects its card. The detail reads the
  transcript when it opens; it does not stream. Live status is read when the row is served.
- **Resume.** A conversation (interactive, SDK or unclassified) whose transcript is on disk and
  which the Registry is not running offers **Resume** instead of Open in Fleet. One-shot and
  reviewer runs, and sessions whose transcript is gone, offer neither. See [Resume](#resume).

## Resume

**Resume** opens a dialog that reads the session's original directory and any launch of it
already open, then lists the terminals that can host an agent. Choosing one opens a new
**unmanaged** terminal session running the agent's own resume command (`claude --resume <id>`,
with the permission mode the transcript last recorded) in that directory, or in a worktree
slot. It is prepared from
the catalog row alone: no task context and no Mission Control tools. Discovery then registers
the agent like any other terminal session, which turns the row **Live**.

- **Original directory.** The default target, when it still exists and lies outside every
  worktree pool. It is resolved once through symlinks, and that value is the launch's
  directory, the terminal's working directory and the binding key.
- **Original slot.** An idle slot never keeps a branch, so an original directory inside a pool
  is a slot target on its own slot. When that slot is idle, the Resume leases it and checks out
  the recorded branch (below). When another owner holds it, or it is not idle for any other
  reason (a slot left standing on a branch included), it counts as reused.
- **Picker.** When the original directory is gone, reused or never recorded, the dialog offers
  the idle, clean slots of the session's repository (the slots the slot lease below would
  take: acquisition's own idle rule plus a detached HEAD, read from one inventory observation,
  `observedAsIsRefusal`) and, as another choice, a directory to type (below). A pool that
  cannot be read offers no slot, and an original directory inside it is refused with
  `pool_unavailable`, naming why, rather than called reused. A session with no resolvable repository is offered no slot. A slot of another
  repository, or one never offered, is refused with `slot_not_offered`. The terminal opens in
  the slot's root.
- **Slot target.** The worktree manager's `leaseForResume` leases the slot to the manual owner
  `history-resume-<launchId>`, which the slot card names "Resumed History session". It leases
  only an idle, detached slot, exactly as Open terminal's lease does, so a slot attached to a
  branch is refused. Before it touches the slot it reads `git worktree list --porcelain`:
  - The recorded branch, when it has a local branch, is checked out attached.
  - A branch only origin's remote-tracking ref holds is checked out as a new local branch
    tracking it. Nothing is fetched first.
  - A branch another worktree holds (a slot another owner has, a task worktree, or a checkout
    outside the pool) has its tip checked out detached. The dialog warns that commits made in
    the slot will not move the branch.
  - A branch found nowhere, or nothing recorded that is a branch name (none, `HEAD`, or a value
    Git would read as an option), leaves the slot detached where it was. The
    dialog warns that the code may not match the conversation.

  A slot that is no longer idle when the Resume runs is refused with `slot_unavailable`, and
  the launch is released. A checkout that failed and left the slot as it was hands the slot
  back; one that may have moved it quarantines the slot under the Resume's owner, whose card
  offers Return. A launcher that refuses after the lease Returns the slot, which resets it.
- **Returning a slot.** A launch with a slot holds the slot until its session ends clean (see
  **When the session ends**) or the operator Returns the slot from its card in Settings,
  Worktrees. The launch row records the slot and
  its lease, and once that lease is gone (on the Registry's `worktrees_changed`, and on every
  expiry tick) the launch is `released`, so a new Resume can start. Whether a slot still holds
  a launch is the worktree manager's answer (`WorktreeManager.holds`); History reads only its
  own table. A slot also still holds a
  launch while its active owner is that launch's `history-resume-<launchId>`, which covers a
  daemon that stopped after granting the lease and before recording it. A launch a previous
  daemon made with no lease recorded is judged by that owner alone, since no lease can still be
  in flight after a restart: if no slot carries its owner, it is released. Cancel pending resume
  never closes a launch with a slot.
- **Another directory.** When the original directory cannot be used, the dialog also offers a
  **Resume in another directory** field (the only choice when no slot is offered), and lists
  the terminals once a path is typed. The path must be absolute; a relative one is refused and
  the field stays up. It must be an existing directory outside every worktree pool (a pool
  directory is refused: choose an offered slot instead), and it is
  resolved once with `realpath`: that value is the project folder the copy goes into, the
  launch's directory, the terminal's working directory and the binding key, because Claude
  encodes the directory it actually runs in.
- **A fork from a copy.** For another directory, the transcript is copied into that
  directory's Claude project folder (`~/.claude/projects/<encoded directory>/<sessionId>.jsonl`)
  and the agent starts with `claude --resume <id> --fork-session --session-id <new>`, where
  `<new>` is an id Mission Control minted before launch. The fork is a new session that appears
  in History on its own, with `resumed_from` naming the original; the original transcript is
  never touched. **This copy is an unofficial workaround:** it is History's only write into
  Claude Code's store, it relies on Claude Code finding a session by its file in the project
  folder, and it may break with a Claude Code format change.
- **The copy never overwrites.** Project folder names are a lossy encoding, so two directories
  can share one folder, including the original's. The copy is an exclusive create (`O_EXCL`).
  A file already there that an earlier Resume recorded as its copy of this session is reused as
  it stands, with no write, while it is still a byte prefix of the original transcript: a fork
  never changes its source, and the original only grows by appending. A recorded copy that
  something has written to since (Claude's own resume run in that directory) is no longer this
  conversation and refuses, as does any other file of that name, the original transcript
  included. Nothing is written in either case.
- **One open launch per session.** Every Resume first writes one row to
  `history_resume_launches`, before it prepares or opens anything. A partial unique index on
  the session over the `pending` and `expired` states makes that insert the claim: of two
  concurrent Resumes, one gets a launch and the other is refused, having started nothing. A
  later step that fails releases the row; a terminal whose outcome is unknown keeps it, since
  its agent may still appear.
- **Binding.** A launch binds to the Registry session whose agent session id is the launch's
  expected id **and** whose working directory, resolved through symlinks, is the launch's
  directory. A session with the right id anywhere else binds nothing. When the bound session
  leaves the Registry the launch is `ended`.
- **When the session ends.** An `ended` launch with a slot hands the slot back to the pool when
  the slot is clean, and the launch is `released`. Clean means both: no uncommitted changes, and
  no commit reachable from `HEAD` that no branch, tag or remote-tracking ref holds
  (`git rev-list HEAD --not --branches --tags --remotes` is empty), so work made on a detached
  `HEAD` is never reset away to the reflog. Commits on an attached branch do not count, since
  the branch holds them. The check runs in the worktree manager (`returnResumed`), once before
  the return fetches and again just before it resets. A slot that is not clean stays leased,
  the launch stays `ended` with its reason in `kept_reason`, and the slot card says
  "Kept: uncommitted changes from a resumed session" or "Kept: commits on no branch from a
  resumed session" until the operator Returns it. A hand-back refused for a passing reason, such
  as a process still inside the slot, is retried on every discovery tick. Only a launch that was
  `bound` is ever released this way.
- **Closing an unbound launch.** A launch with no worktree slot that has not bound within its
  grace window (the managed resume start deadline plus two discovery sweeps) is `released`. A
  launch with a slot is `expired` instead and keeps its lease, so the pool never hands out or
  resets the slot under a late agent. Its slot card says "Held for a resumed session that has
  not appeared" and offers Return, and a second Resume of the session is refused until then. An
  agent that appears after expiry still binds, by id and directory, and its slot is handed back
  like any bound launch's when it ends.
  While it is `pending`, the dialog offers **Cancel pending resume**, which releases it at once
  and revokes its prepared environment if no terminal has claimed it. A Resume still
  preparing or opening its terminal when that happens stops, and answers `cancelled`. After a
  restart, once the first discovery sweep finishes, a `bound` launch whose agent is no longer
  running is `ended` and goes through the same hand-back, and a `pending` one is `expired` when
  it has a slot and `released` when it has none; a slotless launch is never left `expired`.
- **Refusals** are explicit, each with a code and a sentence: a background run, a gone
  transcript, a live session, an open launch (naming its directory), no recorded directory, a
  missing directory, a reused slot, a pool that could not be read, a pool directory typed as a
  directory, a relative typed
  path, a file in the destination project folder that is not History's copy of this session, a
  slot never offered, a slot no longer idle, a harness that cannot resume, a terminal that
  cannot host an agent, a launch that failed, or a launch Cancel pending resume closed while it
  was still starting.

## Session kinds

A Claude session's kind comes from its transcript, by these rules in order; the first match
wins:

1. `interactive` when its `entrypoint` is `cli`.
2. `unclassified` when no `prompt_snapshot` recorded a tool list. A missing snapshot is never
   read as an empty tool set.
3. `one_shot` when the snapshot lists no tools, or only `StructuredOutput`.
4. `reviewer` when it lists at least one of `Read`, `Glob` or `Grep`, and nothing outside
   `Read`, `Glob`, `Grep` and `StructuredOutput`.
5. `sdk` when the snapshot's `cliPrefix` is Claude Code's own preset.
6. `unclassified` otherwise.

The rules live in the Claude reader (`src/server/harness/claude/history.ts`), not in shared
code. Kinds are persisted (`HISTORY_KINDS` in `src/shared/history.ts`) and append-only.

## How the catalog is kept

- **Reader.** Each harness declares a nullable `history` slot (`HistorySpec` in
  `src/server/harness/types.ts`): the roots to walk, how to enumerate transcripts, an
  incremental summarize, the stable rule that chooses between two files carrying one
  session id, and the on-demand conversation and launch-context readers. Claude's walks `~/.claude/projects` (a custom `CLAUDE_CONFIG_DIR` is not
  followed), lists only top-level `<sessionId>.jsonl` files, and counts subagent runs under
  `<sessionId>/subagents/` without listing them as sessions. The count is exactly the runs a
  session's detail lists: regular `agent-<agentId>.jsonl` files whose id is in the subagent
  route's format. It reads `cwd` from records, never from the
  project folder name, and skips record and attachment types it does not know.
- **Store.** `history_sessions` in `harness.db`, one row per agent and session id, and
  `history_search_segments`, its folded search text (fields at ordinal 0, prompts after, in
  overlapping chunks; not FTS5). Both are created in `migrate()` and written only by
  `HistoryStore`. See
  [database and migrations](database-and-migrations.md).
- **Reconciler.** `HistoryReconciler` starts after the daemon is serving and rescans every
  30 seconds. It also watches each root with `fs.watch` (recursive where the platform supports
  it) and starts a pass a second after a transcript moves. The watcher is only a hint: a root
  that does not exist yet is watched from the first pass after it appears, and an event the
  watcher misses delays a row until the next scan. An unchanged transcript costs one `lstat`; a
  changed one is re-summarized from the byte where its last parse stopped, and a file smaller
  than it was or a new inode at the same path starts over. A file
  that holds nothing a row can be built from is remembered with its fingerprint and not read
  again until it changes. Several files carrying one session id are compared only when one of
  them appeared, went or changed. New and
  changed files are indexed newest first in batches of 25, each written in one short
  transaction followed by a yield to the event loop. A row is marked gone only after a pass
  walked every root of its harness without seeing the file. A root, project folder or file
  that exists but could not be read (permissions, I/O) makes the walk incomplete, and an
  incomplete walk decides nothing; only one that is not there at all counts as empty.
- **One row per session id.** A Resume into another directory leaves two files with one
  session id. A file a launch recorded as its copy (`history_resume_launches.copy_path`) is
  never canonical; of the rest, the file in the project folder that encodes the session's first
  recorded cwd wins, then the earliest first record, ties broken by path, so a rebuilt catalog
  picks the same file whatever order it scans in. A copy never creates a second row. When the
  canonical file disappears the row is marked gone, never repointed at a recorded copy. A file
  nothing recorded as a copy competes like any other, so a transcript moved with its project
  folder is followed, as a rebuilt catalog would choose it.
- **Change event.** A pass that wrote or marked any row publishes one `history_changed` server
  event, however many rows and batches it covered; a pass that changed nothing publishes none.
  The event carries no data. See [the event stream](event-stream.md).
- **Search text.** Written with its row. An appended transcript adds the prompts on its new
  complete lines; one read from the top replaces them all. A session indexed as a background run
  that later reads as a conversation is read again from the top, so its earlier prompts are
  indexed too.
- **Repository.** Resolved when a row is indexed and stored: a worktree pool slot maps to its
  pool's main checkout by path segment over `worktree_pools` (`poolContainingPath`), even after
  the slot directory is gone; a `worktrees/<taskId>` checkout maps to its task's repository; any
  other existing path resolves through Git to its main repository root; anything else has no
  repository, and the row shows its raw cwd.

## API

`GET /api/history/sessions?cursor&limit&q&repo&from&to&kind&agent` returns
`{sessions, nextCursor, progress, facets}`: one page of matching sessions, newest activity
first; the backfill's `{indexing, indexed, total}`; and `facets` - the agents with a reader,
every resolved repository, and each reader's retention period. `from` and `to` are epoch
milliseconds on last activity, `from` inclusive and `to` exclusive. `kind` is `all` or one
kind; absent means conversations. It is loopback-only like the rest of `/api/*`, takes no path,
and is not exposed as an MCP tool. A malformed cursor, an out-of-range limit, an unknown kind
or agent, a query over 200 characters, or any parameter it does not know is refused with 400.

Every route is loopback-only like the rest of `/api/*`, takes no path except Resume's typed
directory (absolute, resolved with `realpath`, and only ever the destination of a copied
transcript), and is not exposed as an MCP tool. A session is addressed as `:agent/:id`, where `:id` must be a UUID; its transcript
path always comes from the catalog.

| Route | Returns |
|---|---|
| `GET /api/history/sessions?cursor&limit&q&repo&from&to&kind&agent` | The list, described above. |
| `GET /api/history/sessions/:agent/:id` | `{session, subagents}`: the catalog row, and the subagent runs the session's own `subagents/` folder lists (empty once the transcript is gone). 404 for an agent with no reader, a non-UUID id, or an id the catalog does not know. |
| `GET /api/history/sessions/:agent/:id/messages?cursor` | `{messages, nextCursor}`: a window of turns read forward from the byte offset `cursor` (the top when absent), through the same path-based window reads a live session uses. A window is at least 100 turns and 512 KB. 410 when the transcript file is gone (missing on disk, whether or not a walk has marked it yet); 500 naming the reason (`EACCES`, `ELOOP`, not a regular file) when it is there but cannot be read, so it is never shown as removed, empty or finished; 404 as above, or when the cataloged path does not resolve, through symlinks, under one of its harness's roots. A malformed cursor is refused with 400. |
| `GET /api/history/sessions/:agent/:id/launch-context` | `{instructionFiles, systemPrompt, skills, mcp, environment, hooks}` (`HistoryLaunchContext`), parsed from the transcript on each request by the harness's `launchContext` reader. A section is `null` when the transcript holds no record of it. 404, 410 and 500 as for `messages`. |
| `GET /api/history/sessions/:agent/:id/tool-results/:toolUseId` | `{toolUseId, source, isError, text, truncated}`: one tool call's result, `inline` from its transcript record or `sidecar` from the file that record names. 404 when no record holds a result for the id, or its sidecar is missing or not reachable; 410 when the transcript is gone. |
| `GET /api/history/sessions/:agent/:id/subagents/:agentId/messages?cursor` | `{messages, nextCursor}`: a window of one subagent run's transcript, paged like `messages`. 404 when the run is not in the session's own listing; 410 when the session's transcript is gone. |
| `GET /api/history/sessions/:agent/:id/resume-options` | `{original: {cwd, resolved, state, slot, refusal}, openLaunch, refusal, picker}`: the original directory as recorded, resolved through symlinks, its state (`usable`, `missing`, `pool_slot`, `unrecorded`, `slot_reused`), the slot it is, if any, and why a Resume there would be refused; the session's open launch; the refusal that blocks every target now, or null; and `picker`, `{directory, slots}` when the original cannot be used and nothing else refuses, else null. `directory` is whether the harness can fork; `slots` are the idle slots of the session's repository (`{slotId, ordinal, path, head}`). 404 as above. |
| `POST /api/history/sessions/:agent/:id/resume` | Body `{backend, target}` (`HistoryResumeBodySchema`), where `target` is `{kind: "original"}`, `{kind: "slot", slotId}` or `{kind: "directory", path}`. `{ok: true, launch, label, checkout}` once the terminal opened; a fork's `launch` carries the minted id as `expectedAgentSessionId` and the transcript copy as `copyPath`; `checkout` is what a slot target checked out (`{state: "branch" \| "missing" \| "elsewhere", branch, path?}`), or null outside the pool. A refusal is `{ok: false, code, error, launch?}`: 409 for most, 410 for a gone transcript, 504 when the terminal's outcome is unknown and the launch stays open, 400 for a relative typed path (`directory_relative`) or a body the schema refuses. |
| `POST /api/history/sessions/:agent/:id/resume/cancel` | Body `{launchId}`. Cancel pending resume: `{ok: true, launch}` with the launch released. A refusal is `{ok: false, code, error, launch?}`: 404 `launch_not_found` for a launch of another session; 409 `launch_not_pending` or `launch_has_slot` for a launch that is no longer pending or holds a worktree slot. |

Neither `:toolUseId` nor `:agentId` ever becomes part of a path on its own:

- `:toolUseId` must match `^[A-Za-z0-9_-]{1,128}$`. The result is found by that id in the parent
  transcript. A result kept in a sidecar names its file inside its own record: only the "saved
  to" line of a result that opens with Claude Code's `<persisted-output>` preview counts, so a
  result that merely mentions a `tool-results/` path (a `wc -l` on a saved output, an error
  naming one) or quotes another record's preview (a grep over transcripts) stays its own inline
  result. Only that path's last segment is taken, and it is read from this session's own
  `<sessionId>/tool-results/` folder. A sidecar no record names is never reachable.
- `:agentId` must match `^[0-9a-f]{8,64}$`. It names `agent-<agentId>.jsonl` only when that
  regular file is in the session's own `<sessionId>/subagents/` listing; a listing reached
  through a symlinked folder lists nothing.
- Every resolved file goes through `realpath` and must lie under that session's own
  `tool-results/` or `subagents/` folder, not merely under the harness root. Anything else,
  including a format failure, an encoded separator or a symlink out of the folder, is a 404.

History's reading of a transcript differs from the live view's only in what it adds: each tool
call carries its `tool_use` id, input is cut at 256 KB rather than 1,800 characters, and a
`compact_boundary` record and the summary after it are marked (`presentation.kind` `compaction`
and `compaction_summary`). The live readers do none of this.

Every row carries `liveSessionId`: the Registry session running that conversation now, joined
when the row is served and never stored.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `MISSION_HISTORY_RECONCILE_MS` | `30000` | Rescan cadence; `0` turns the recurring scan off. |
| `MISSION_HISTORY_BATCH_SIZE` | `25` | Transcripts summarized per batch. |
| `MISSION_HISTORY_BATCH_PAUSE_MS` | `0` | Extra pause after each batch, for tests that watch a backfill. |
