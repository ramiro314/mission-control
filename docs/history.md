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
- **Conversations by default.** The list shows interactive, SDK and unclassified sessions,
  and every session a Mission Control task ran, whatever its kind. Other one-shot and reviewer
  runs, which are most of what Mission Control's own background work leaves behind, are listed
  only when the **Kind** filter asks for them.
- **Title.** The bound task's title, else the session's custom title, its AI title, then its
  first prompt.
- **Row.** Repository (or the raw cwd when no repository was resolved, with the full cwd on
  hover), branch, kind, model, cost and duration, then, for a bound session, its task's status
  and outcome, and its pull request (Mission Control's, else the last one the transcript
  recorded).
- **Cost.** The transcript's own `cost-state`, else the session's spend in Mission Control's
  `usage_ledger`. A ledger that holds any unpriced row for the session shows no cost rather
  than a subtotal.
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

Every control lives in the page's URL (`#/history?q=&repo=&from=&to=&kind=&agent=&link=&outcome=&pr=`) and
replaces the route as it changes, so a filtered list survives a reload and can be shared,
and refining it leaves no trail of entries for Back. A value this build would refuse (an
unknown kind, an impossible day) is dropped from the URL rather than sent.

- **Search** waits for typing to settle, then matches a literal, case-folded substring against
  each session's titles (custom, AI, first prompt and a bound task's title), cwd, repository, branch and indexed user
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
- **Mission Control** is a session a task managed, or **External**: one no task ran.
- **Outcome** is the bound task's status (`done`, `failed`, `cancelled`, or one still
  running), so it lists only task-bound sessions.
- **PR** is **With a PR** (Mission Control's, or one the transcript recorded), **PR merged**
  (Mission Control recorded the merge), or **No PR**.
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
  activity, duration and cost, each shown when the transcript recorded it. A bound session also
  shows its **Task**, which opens the task where the dashboard shows it (a finished one in the
  Sitrep) when the dashboard still holds it, and its outcome and pull request.
- **Not indexed.** A bound session whose transcript was deleted before the catalog ever indexed
  it still opens: the header is built from Mission Control's data alone (task title and kind,
  outcome, pull request, repository, branch, ledger cost) with a **Not indexed** badge, no
  tabs and no Resume, and says the transcript was removed before Mission Control indexed it.
  The reconciler never writes a catalog row for such a session.
- **Conversation.** The session's messages, rendered by the same component the live
  conversation panel uses (`ConversationMessages` in `TranscriptPanel.tsx`), read from the
  transcript on disk from the top. **Load more messages** reads the next window. It is
  read-only: there is no composer.
- **Transcript gone.** The header stays, with the **Transcript gone** badge, and the
  conversation says it was removed by Claude Code's retention.
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
  incremental summarize, and the stable rule that chooses between two files carrying one
  session id. Claude's walks `~/.claude/projects` (a custom `CLAUDE_CONFIG_DIR` is not
  followed), lists only top-level `<sessionId>.jsonl` files, and counts subagent runs under
  `<sessionId>/subagents/` without listing them. It reads `cwd` from records, never from the
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

## Mission Control data

What Mission Control knows about a session is joined when a row is served, never stored, so
it augments a record without being part of it, and a session Mission Control never touched has
a complete record without it. The session's agent session id joins, in `HistoryStore`:

- `task_work_episode_bindings`, else the newest `historical_task_work_episode_bindings` row,
  for the task, PR URL, merge time and branch, and that task's row in `tasks` (title, kind,
  status, outcome, outcome URL, workflow, labels, repository). A binding joins only a session
  of its task's own agent.
- `session_agent_bindings`, for the Mission Control session that ran it.
- `usage_ledger` by note key, priced by `sessionCostsFor`, the same rule a card's cost uses, for
  the cost fallback (`historyCost` in `src/shared/history.ts` decides it, for a row and for a
  record the catalog never indexed).

## API

`GET /api/history/sessions?cursor&limit&q&repo&from&to&kind&agent&link&outcome&pr` returns
`{sessions, nextCursor, progress, facets}`: one page of matching sessions, newest activity
first; the backfill's `{indexing, indexed, total}`; and `facets` - the agents with a reader,
every resolved repository, and each reader's retention period. `from` and `to` are epoch
milliseconds on last activity, `from` inclusive and `to` exclusive. `kind` is `all` or one
kind; absent means conversations, which includes every task-bound session. `link` is `task`
or `external`, `outcome` a task status, and `pr` is `any`, `merged` or `none`. It is loopback-only like the rest of `/api/*`, takes no path,
and is not exposed as an MCP tool. A malformed cursor, an out-of-range limit, an unknown kind
or agent, an unknown link, outcome or PR value, a query over 200 characters, or any parameter it does not know is refused with 400.

Every route is loopback-only like the rest of `/api/*`, takes no path, and is not exposed as an
MCP tool. A session is addressed as `:agent/:id`, where `:id` must be a UUID; its transcript
path always comes from the catalog.

| Route | Returns |
|---|---|
| `GET /api/history/sessions?cursor&limit&q&repo&from&to&kind&agent&link&outcome&pr` | The list, described above. |
| `GET /api/history/sessions/:agent/:id` | `{catalog}`: the catalog row exactly as the list serves it, with its live status and Mission Control's join. With no catalog row, `{catalog: null, mission}`, when a task binding or a Mission Control session names the id: Mission Control's record alone, with the session's `agent`, `agentSessionId` and `liveSessionId`. 404 for an agent with no reader, a non-UUID id, or an id neither the catalog nor Mission Control knows; a ledger row alone names nothing. |
| `GET /api/history/sessions/:agent/:id/messages?cursor` | `{messages, nextCursor}`: a window of turns read forward from the byte offset `cursor` (the top when absent), through the same path-based window reads a live session uses. A window is at least 100 turns and 512 KB. 410 when the transcript file is gone (missing on disk, whether or not a walk has marked it yet); 500 naming the reason (`EACCES`, `ELOOP`, not a regular file) when it is there but cannot be read, so it is never shown as removed, empty or finished; 404 as above, or when the cataloged path does not resolve, through symlinks, under one of its harness's roots. A malformed cursor is refused with 400. |

Every row carries `liveSessionId`, the Registry session running that conversation now, and
`mission`, what Mission Control knows about it (null when nothing), with `costSource` saying
whether `costUsd` came from the transcript or the ledger. All three are joined when the row is
served and never stored.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `MISSION_HISTORY_RECONCILE_MS` | `30000` | Rescan cadence; `0` turns the recurring scan off. |
| `MISSION_HISTORY_BATCH_SIZE` | `25` | Transcripts summarized per batch. |
| `MISSION_HISTORY_BATCH_PAUSE_MS` | `0` | Extra pause after each batch, for tests that watch a backfill. |
