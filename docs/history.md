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
  that file, cut at 1 MB. A call with no recorded result, or whose sidecar file is gone or not
  reachable, says **Result unavailable** and why.
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

Every route is loopback-only like the rest of `/api/*`, takes no path, and is not exposed as an
MCP tool. A session is addressed as `:agent/:id`, where `:id` must be a UUID; its transcript
path always comes from the catalog.

| Route | Returns |
|---|---|
| `GET /api/history/sessions?cursor&limit&q&repo&from&to&kind&agent` | The list, described above. |
| `GET /api/history/sessions/:agent/:id` | `{session, subagents}`: the catalog row, and the subagent runs the session's own `subagents/` folder lists (empty once the transcript is gone). 404 for an agent with no reader, a non-UUID id, or an id the catalog does not know. |
| `GET /api/history/sessions/:agent/:id/messages?cursor` | `{messages, nextCursor}`: a window of turns read forward from the byte offset `cursor` (the top when absent), through the same path-based window reads a live session uses. A window is at least 100 turns and 512 KB. 410 when the transcript file is gone (missing on disk, whether or not a walk has marked it yet); 500 naming the reason (`EACCES`, `ELOOP`, not a regular file) when it is there but cannot be read, so it is never shown as removed, empty or finished; 404 as above, or when the cataloged path does not resolve, through symlinks, under one of its harness's roots. A malformed cursor is refused with 400. |
| `GET /api/history/sessions/:agent/:id/launch-context` | `{instructionFiles, systemPrompt, skills, mcp, environment, hooks}` (`HistoryLaunchContext`), parsed from the transcript on each request by the harness's `launchContext` reader. A section is `null` when the transcript holds no record of it. 404, 410 and 500 as for `messages`. |
| `GET /api/history/sessions/:agent/:id/tool-results/:toolUseId` | `{toolUseId, source, isError, text, truncated}`: one tool call's result, `inline` from its transcript record or `sidecar` from the file that record names. 404 when no record holds a result for the id, or its sidecar is missing or not reachable; 410 when the transcript is gone. |
| `GET /api/history/sessions/:agent/:id/subagents/:agentId/messages?cursor` | `{messages, nextCursor}`: a window of one subagent run's transcript, paged like `messages`. 404 when the run is not in the session's own listing; 410 when the session's transcript is gone. |

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
