import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { TestingSetupMode } from "@shared/protocol.ts";
import type { ForemanState } from "../useForeman.ts";
import type { InspectorState } from "../useInspector.ts";
import type { ShippingState } from "../useShipping.ts";
import type { WorkflowSettingsState } from "../useWorkflowSettings.ts";
import { useUiConfig, updateUiConfig } from "../lib/uiConfig.ts";
import { api, fetchRepos, resolveRepo } from "../lib/api.ts";
import {
  addRepositoriesPatch,
  candidateRepos,
  checkExecutionGrants,
  DEFAULT_ADD_GRANTS,
  grantFailureMessage,
  grantPatch,
  mergeBlindSpots,
  planBatchAdd,
  trustRows,
  type ChecksArmedReading,
  type GrantColumn,
  type TrustRow,
} from "../lib/trust.ts";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { repoLeaf } from "../lib/format.ts";
import { useTourTargetRef } from "../tour/target-context.tsx";
import { filterRepos, repoOptionLabels } from "./RepoCombobox.tsx";
import { RepositoryName } from "./RepositoryName.tsx";
import { Tooltip } from "./Tooltip.tsx";

// Trust: one repository x grant matrix over the four existing allowlists.
//
// It stores NOTHING of its own about who may act where - each column is a subsystem's own
// `repoAllowlist`, and a cell click patches that subsystem's config through the exact route
// its panel used to. The daemon's four consent gates are untouched; this is a view that
// happens to be able to write to what it shows. The one piece of state it does own is the
// staged list (`UiConfig.trustStaged`): a repo in the table that holds no grant lives in no
// allowlist, so without a home of its own it would vanish on the next reload. Adding grants
// `DEFAULT_ADD_GRANTS` straight away, so a repo lands there only when none of those writes
// could be made - or because an older build staged it ungranted.
//
// The page is two panes side by side, so adding never sits below a long table: the left
// pane picks any number of the workspace's repositories (or a typed path) and adds them in
// one batch, the right pane is the matrix with a filter of its own. Each pane scrolls inside
// itself.
//
// Two combinations are flagged amber, and they are different kinds of thing. The merge
// blind spot is a CONTRADICTION - a repo YOLO may merge but the Inspector may not review
// can never qualify, so nothing happens and the reason is invisible - and both the trapped
// merge cell and the empty inspector cell that would fix it go amber, with a footnote
// offering the two fixes in place. Armed check execution is not broken at all; it is
// flagged because it is the heaviest grant here and the one whose weight the cell cannot
// show on its own. See `checkExecutionGrants`.

/**
 * The four columns, left to right, each naming the grant by what it permits.
 *
 * `label` is the grant's full name, which every cell's accessible name and the header's
 * tooltip carry. `short` is what the header prints: the matrix shares its row with the add
 * pane, and the full names would not fit four columns of pills beside it.
 */
const COLUMNS = [
  {
    key: "foreman",
    label: "Foreman sends live",
    short: "Foreman",
    title: "Foreman answers prompts in this repo's sessions without asking you.",
  },
  {
    // Second, not last: the columns run local-blast-radius first (Foreman, Workflows) and
    // GitHub second (Inspector, YOLO), so the two halves of the "Acts on GitHub" badge the
    // rail draws over this category are contiguous rather than interleaved.
    key: "workflows",
    label: "Workflows act",
    short: "Workflows",
    // ONE cell, both capabilities, because it is one stored list - said in full here since
    // this tooltip is the only place the second one is visible from the matrix.
    //
    // It no longer says the two are "armed separately in Workflows settings". Both switches
    // now ship ON, so on a machine nobody has reconfigured this cell is the LAST gate for
    // both, and describing the grant as half a decision would understate it at exactly the
    // moment it is being made.
    //
    // But it must not overstate it either, and "both are on unless you turned them off" did:
    // a policy stored before `checksEnabled` existed is held OFF by `getWorkflowPolicy`, so
    // an upgraded machine can grant this cell and still run no Command. Pointing at the
    // Workflows panel rather than asserting a state is the honest form - that panel says
    // which way each switch actually is, and this tooltip cannot know. The double dagger
    // below the matrix answers it for real, naming the repositories where Commands are live.
    title:
      "Workflows may act in this repo: Live repairs typed into its sessions, and workflow "
      + "Commands run against branch code with the daemon's filesystem authority. New "
      + "installations ship both on; Workflows settings shows where yours stand.",
  },
  {
    key: "inspector",
    label: "GitHub Inspector posts reviews",
    short: "GitHub Inspector",
    title: "Publishes review comments on this repo's PRs under your GitHub account.",
  },
  {
    key: "merge",
    label: "YOLO merges",
    short: "YOLO merges",
    title: "Clean, soaked PRs in this repo merge themselves to the base branch.",
  },
] as const;

/**
 * Compact repository names inside a warning, except where compacting would make two entries
 * read as the same repository. In that collision only, the full paths stay visible as well
 * as available on hover; `api, api` would otherwise look like a rendering error and leave the
 * reader unable to tell which grant each occurrence names.
 */
function WarningRepositoryList({ repos }: { repos: string[] }): React.JSX.Element {
  const leafCounts = new Map<string, number>();
  for (const repo of repos) {
    const leaf = repoLeaf(repo);
    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);
  }

  return (
    <>
      {repos.map((repo, index) => {
        const ambiguous = (leafCounts.get(repoLeaf(repo)) ?? 0) > 1;
        return (
          <Fragment key={repo}>
            {index > 0 ? ", " : null}
            {ambiguous ? (
              <Tooltip label={repo}>
                <span className="trust-warning-repo">{repo}</span>
              </Tooltip>
            ) : (
              <RepositoryName path={repo} className="trust-warning-repo" />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

export function TrustPanel({
  foreman,
  workflows,
  inspector,
  shipping,
  checks,
}: {
  /**
   * The four subsystem states, OWNED ELSEWHERE and passed in: Foreman by App (the topbar
   * shares it), Workflows, the Inspector and Shipping by `SettingsPage`. Trust must not
   * instantiate a second `useForeman`/`useWorkflowSettings`/`useInspector`/`useShipping` -
   * that would double-poll the same routes App and the page already poll, and let a cell
   * and a panel disagree about a list.
   */
  foreman: ForemanState;
  workflows: WorkflowSettingsState;
  inspector: InspectorState;
  shipping: ShippingState;
  /**
   * Whether a Check node may run branch-authored code, and whether that is confirmed.
   *
   * PASSED IN, not derived from `workflows.config` here, because it has to survive a failed
   * poll: `useWorkflowSettings` nulls its config on any read that fails, and this panel
   * unmounts whenever another category is open, so a memory kept here would reset every
   * time you navigated away. `SettingsPage` is mounted for the whole settings session and
   * owns it, which is also what keeps this footnote and the rail dot saying the same thing.
   */
  checks: ChecksArmedReading;
}): React.JSX.Element {
  // The two spotlights the Setup tour's Trust half points at: the whole matrix, and the pane
  // that adds repositories to it. The matrix rather than a cell or a column - which grants a
  // machine needs depends on which repositories it works in, and a row may not exist yet.
  const matrixTourRef = useTourTargetRef<HTMLDivElement>("setup:trust-matrix");
  const addTourRef = useTourTargetRef<HTMLDivElement>("setup:trust-add");
  const ui = useUiConfig();
  /** The workspace's repositories, or null until the first read lands. */
  const [repos, setRepos] = useState<string[] | null>(null);
  /** The add pane's search over repositories not yet in the matrix. */
  const [pickQuery, setPickQuery] = useState("");
  /** Picked repositories, kept across searches so a batch can be built from several. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  /** A path typed by hand, for a checkout the workspace scan did not find. */
  const [pathDraft, setPathDraft] = useState("");
  /** The matrix pane's filter over repositories already in it. */
  const [trustedQuery, setTrustedQuery] = useState("");
  /** The last batch added, tagged "new" in the matrix so the rows can be found again. */
  const [recent, setRecent] = useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Each row's "Set up flake-aware testing" request and its answer, keyed by repository so rows
  // stay independent: a request in flight on one row neither disables another row's button nor
  // lets its answer land under the wrong row.
  const [setups, setSetups] = useState<Record<string, {
    state: "busy" | "started" | "queued" | "refused";
    text: string;
  }>>({});
  const setupsRef = useRef(setups);
  setupsRef.current = setups;
  // The rows whose "where do the testing settings live?" choice is open. The action never starts
  // a task on its first click: committed and stored lead to different agents doing different
  // things to the repository, so the operator picks one before anything is filed.
  const [choosing, setChoosing] = useState<ReadonlySet<string>>(new Set());

  // The workspace's git repos, for the add picker - same source the four panels used.
  useEffect(() => {
    void fetchRepos().then(setRepos);
  }, []);

  const foremanList = foreman.config?.repoAllowlist ?? [];
  const workflowsList = workflows.config?.repoAllowlist ?? [];
  const inspectorList = inspector.config?.repoAllowlist ?? [];
  const shippingList = shipping.config?.repoAllowlist ?? [];
  const staged = ui.trustStaged;
  const yolo = shipping.config?.autoMerge ?? false;
  const checksArmed = checks.armed;

  // The stale-closure guard the panels use, five times over: every write does a server
  // round-trip while the configs poll every 4-5s underneath it, so a cell click must
  // extend whatever is in force when it lands, not what was on screen when it was clicked.
  const foremanRef = useRef(foremanList);
  foremanRef.current = foremanList;
  const workflowsRef = useRef(workflowsList);
  workflowsRef.current = workflowsList;
  const inspectorRef = useRef(inspectorList);
  inspectorRef.current = inspectorList;
  const shippingRef = useRef(shippingList);
  shippingRef.current = shippingList;
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  // Workflows' route is a PUT of the WHOLE config, not a patch like the other three, so a
  // write here has to spread a config object - and spreading the render-time one would post
  // a stale `liveEnabled`/`checksEnabled`/retention back over whatever a poll or another tab
  // changed in the meantime. Held as a ref for the same reason the lists are.
  const workflowConfigRef = useRef(workflows.config);
  workflowConfigRef.current = workflows.config;

  const rows = trustRows({
    foreman: foremanList,
    workflows: workflowsList,
    inspector: inspectorList,
    shipping: shippingList,
    staged,
  });
  const blindSpots = mergeBlindSpots(rows, yolo);
  const blindRepos = blindSpots.map((r) => r.repo);
  const checkGrants = checkExecutionGrants(rows, checksArmed);
  const checkRepos = checkGrants.map((r) => r.repo);

  // "Unknown, not off" (D7): a null config is an unreachable daemon, which is not evidence
  // the grant is absent. Name which subsystems we cannot read rather than drawing their
  // columns as if empty were fact.
  const unknown = [
    !foreman.config && "Foreman",
    !workflows.config && "Workflows",
    !inspector.config && "GitHub Inspector",
    !shipping.config && "Shipping",
  ].filter((x): x is string => Boolean(x));

  async function grant(key: GrantColumn, repo: string, on: boolean): Promise<void> {
    // The decision - owning subsystem, full new list, staged prune - is a pure function so
    // it can be tested without a click; the refs feed it whatever is in force right now.
    const plan = grantPatch(key, repo, on, {
      foreman: foremanRef.current,
      workflows: workflowsRef.current,
      inspector: inspectorRef.current,
      shipping: shippingRef.current,
      staged: stagedRef.current,
    });
    let ok: boolean;
    if (plan.subsystem === "foreman") {
      if (!foreman.config) return;
      ok = await foreman.update({ repoAllowlist: plan.repoAllowlist });
    } else if (plan.subsystem === "workflows") {
      const config = workflowConfigRef.current;
      if (!config) return;
      ok = await workflows.update({ ...config, repoAllowlist: plan.repoAllowlist });
    } else if (plan.subsystem === "inspector") {
      if (!inspector.config) return;
      ok = await inspector.update({ repoAllowlist: plan.repoAllowlist });
    } else {
      if (!shipping.config) return;
      ok = await shipping.update({ repoAllowlist: plan.repoAllowlist });
    }
    // Retire the staged entry ONLY after the grant write is confirmed: pruning it
    // eagerly would, on a rejected write, leave the repo in no allowlist AND no longer
    // staged - vanishing the row despite the operator's click. A failed grant keeps the
    // staged row, so the ungranted repo stays visible to try again.
    if (ok && plan.trustStaged !== null) {
      void updateUiConfig({ trustStaged: plan.trustStaged });
    }
  }

  function removeRow(row: TrustRow): void {
    if (row.foreman && foreman.config) {
      void foreman.update({ repoAllowlist: foremanRef.current.filter((p) => p !== row.repo) });
    }
    if (row.workflows && workflowConfigRef.current) {
      void workflows.update({
        ...workflowConfigRef.current,
        repoAllowlist: workflowsRef.current.filter((p) => p !== row.repo),
      });
    }
    if (row.inspector && inspector.config) {
      void inspector.update({ repoAllowlist: inspectorRef.current.filter((p) => p !== row.repo) });
    }
    if (row.merge && shipping.config) {
      void shipping.update({ repoAllowlist: shippingRef.current.filter((p) => p !== row.repo) });
    }
    if (stagedRef.current.includes(row.repo)) {
      void updateUiConfig({ trustStaged: stagedRef.current.filter((p) => p !== row.repo) });
    }
  }

  // The dagger's two fixes, applied in place - the operator is already on Trust, so there is
  // nowhere to navigate. Grant the review adds the trapped repos to the Inspector's list;
  // revoke the merge drops them from Shipping's. Either one resolves the blind spot.
  function grantReview(): void {
    if (!inspector.config) return;
    const add = blindRepos.filter((r) => !inspectorRef.current.includes(r));
    if (add.length === 0) return;
    void inspector.update({ repoAllowlist: [...inspectorRef.current, ...add] });
  }
  function revokeMerge(): void {
    if (!shipping.config) return;
    void shipping.update({
      repoAllowlist: shippingRef.current.filter((p) => !blindRepos.includes(p)),
    });
  }

  /**
   * Disarm check execution everywhere, from the footnote that named it.
   *
   * The ONE fix offered, deliberately, though the double dagger has two. Revoking the
   * workflow grants would also silence Live delivery in those repos - a strictly larger
   * change than the operator asked for, applied to every flagged repo at once - so that
   * half stays a sentence pointing at the cells, which are right there and already know how
   * to revoke one repo at a time.
   */
  function disarmChecks(): void {
    const config = workflowConfigRef.current;
    if (!config) return;
    void workflows.update({ ...config, checksEnabled: false });
  }

  /**
   * Add every picked repository, plus a typed path, in one batch - each with the default
   * grants (`DEFAULT_ADD_GRANTS`), and YOLO merges left for a deliberate cell click.
   *
   * One write per owning allowlist rather than one per repository: each config route takes
   * the whole list, so writing them repo by repo would race every write against the last.
   */
  async function add(): Promise<void> {
    const typed = pathDraft.trim();
    const chosen = candidates.filter((r) => picked.has(r));
    if ((chosen.length === 0 && !typed) || adding || awaiting.length > 0) return;
    setAdding(true);
    setAddError(null);
    // Resolve + canonicalize server-side - picked repos as well as the typed path - so every
    // grant is written against the realpath the daemon gates on.
    const asked = typed ? [...chosen, typed] : chosen;
    const resolved = await Promise.all(asked.map((path) => resolveRepo(path)));
    // Duplicate-checked against the whole matrix - the allowlists AND the staged list - so a
    // repo already in it is never added twice.
    const { roots, refused, errors } = planBatchAdd(asked, resolved, new Set(currentRepos()));
    let stagingFailed = false;

    if (roots.length > 0) {
      const patch = addRepositoriesPatch(roots, {
        foreman: foremanRef.current,
        workflows: workflowsRef.current,
        inspector: inspectorRef.current,
        shipping: shippingRef.current,
        staged: stagedRef.current,
      });
      const workflowConfig = workflowConfigRef.current;
      const written = await Promise.all([
        foreman.config ? foreman.update({ repoAllowlist: patch.foreman }) : false,
        workflowConfig
          ? workflows.update({ ...workflowConfig, repoAllowlist: patch.workflows })
          : false,
        inspector.config ? inspector.update({ repoAllowlist: patch.inspector }) : false,
      ]);
      const failed = ["Foreman", "Workflows", "GitHub Inspector"].filter((_, i) => !written[i]);
      if (failed.length === DEFAULT_ADD_GRANTS.length) {
        // Nothing landed, so the new repos sit in no allowlist. Stage them so the rows still
        // show, and their cells can be granted once the daemon answers again - and say so
        // plainly if even that write fails, because then there is no row to click.
        stagingFailed = !(await updateUiConfig({ trustStaged: [...stagedRef.current, ...roots] }));
      }
      const message = grantFailureMessage(failed, roots.length, stagingFailed);
      if (message) errors.push(message);
      if (!stagingFailed) setRecent(new Set(roots));
    }

    // Keep only what was refused, so a failed pick or path can be corrected and retried. A
    // refused pick that is already in the matrix drops out of the list by itself. When the
    // whole add was lost, keep everything, so trying again is one click.
    const keep = (i: number): boolean => stagingFailed || refused.includes(i);
    setPicked(new Set(chosen.filter((_, i) => keep(i))));
    if (!typed || !keep(asked.length - 1)) setPathDraft("");
    setAdding(false);
    setAddError(errors.length > 0 ? errors.join(" ") : null);
  }

  /** Every repository the matrix holds, in any allowlist or staged. */
  function currentRepos(): string[] {
    return [
      ...foremanRef.current,
      ...workflowsRef.current,
      ...inspectorRef.current,
      ...shippingRef.current,
      ...stagedRef.current,
    ];
  }

  /** Open or close one row's mode choice. Opening clears that row's previous answer. */
  function toggleChoice(repo: string): void {
    if (setupsRef.current[repo]?.state === "busy") return;
    const opening = !choosing.has(repo);
    setChoosing((prev) => {
      const next = new Set(prev);
      if (opening) next.add(repo);
      else next.delete(repo);
      return next;
    });
    if (opening) setSetups(({ [repo]: _dropped, ...rest }) => rest);
  }

  /**
   * Start the testing-setup task for one repository in the mode its operator chose. The daemon
   * owns everything the task is - kind, intent, skill, tools - and refuses before creating
   * anything when the skill is off, so the refusal is shown on the row that asked.
   */
  async function startTestingSetup(repo: string, mode: TestingSetupMode): Promise<void> {
    if (setupsRef.current[repo]?.state === "busy") return;
    setChoosing((prev) => {
      const next = new Set(prev);
      next.delete(repo);
      return next;
    });
    const answer = (next: (typeof setups)[string]) =>
      setSetups((prev) => ({ ...prev, [repo]: next }));
    answer({ state: "busy", text: "Starting…" });
    const res = await api.startTestingSetup(repo, mode);
    if (!res.ok || !res.task) {
      answer({ state: "refused", text: res.error ?? "The testing setup task could not be started." });
      return;
    }
    answer(res.launched
      ? {
        state: "started",
        text: mode === "stored"
          ? "Testing setup started with stored settings. Its agent audits this repository and "
            + "proposes its testing settings as a Command document; nothing changes until you "
            + "apply it from Library › Commands."
          : "Testing setup started. Its agent audits this repository and asks you to approve "
            + "every change in one form before it changes anything.",
      }
      : {
        state: "queued",
        text: `Testing setup is in the backlog and has not launched yet: ${res.reason ?? "it will launch when it can"}.`,
      });
  }

  /** Whether each column's owning daemon has answered, so a cell can disable rather than lie. */
  const configPresent: Record<GrantColumn, boolean> = {
    foreman: Boolean(foreman.config),
    workflows: Boolean(workflows.config),
    inspector: Boolean(inspector.config),
    merge: Boolean(shipping.config),
  };

  function cell(row: TrustRow, col: (typeof COLUMNS)[number]): React.JSX.Element {
    const on = row[col.key];
    const blind = yolo && row.merge && !row.inspector;
    // The merge cell that is trapped, and the empty inspector cell that would untrap it,
    // both go amber - the second is where the fix goes.
    const trapCell = (col.key === "merge" && blind) || (col.key === "inspector" && blind);
    const trappedPill = col.key === "merge" && blind;
    // Armed check execution. Only ever the workflows cell, and only when it is granted:
    // unlike the merge trap there is no second cell that would fix it, because the fix is
    // either this grant or a switch that lives on another page.
    const arms = col.key === "workflows" && on && checksArmed;
    // The marker the pill flies, or none. Kept as one expression so the two amber states
    // cannot both claim the same pill - they are on different columns, and this says so.
    const marker = trappedPill ? " †" : arms ? " ‡" : "";
    return (
      <div key={col.key} className={`trust-c${trapCell || arms ? " is-trap" : ""}`}>
        <Tooltip label={col.title}>
          <button
            type="button"
            className={`trust-grant ${on ? "is-on" : "is-off"}${
              trappedPill ? " is-trapped" : ""
            }${arms ? " is-armed" : ""}`}
            disabled={!configPresent[col.key]}
            aria-pressed={on}
            aria-label={`${on ? "Revoke" : "Grant"}: ${col.label} for ${row.repo}`}
            onClick={() => void grant(col.key, row.repo, on)}
          >
            <span className="trust-grant-dot" aria-hidden />
            {on ? `allowed${marker}` : "grant"}
          </button>
        </Tooltip>
      </div>
    );
  }

  const candidates = candidateRepos(repos ?? [], [
    ...foremanList,
    ...workflowsList,
    ...inspectorList,
    ...shippingList,
    ...staged,
  ]);
  // The add pane's list, narrowed by its own search. Picks survive a search that hides them,
  // so the count and the button read from every candidate rather than only the shown ones.
  const shownCandidates = filterRepos(candidates, pickQuery);
  const pickedCount = candidates.filter((r) => picked.has(r)).length;
  const addCount = pickedCount + (pathDraft.trim() ? 1 : 0);
  // The subsystems whose default grant an add would have to skip right now. An add waits for
  // every one of them to answer rather than writing what it can: a subsystem that has not
  // loaded yet is not one that refused, and adding before it does would quietly hand a new
  // repository two grants out of three - which is exactly what a quick add after opening the
  // page used to do.
  const awaiting = [
    !foreman.config && "Foreman",
    !workflows.config && "Workflows",
    !inspector.config && "GitHub Inspector",
  ].filter((x): x is string => Boolean(x));
  // The matrix pane's filter, by the same name-first rule as every repository picker.
  const keepRows = new Set(filterRepos(rows.map((r) => r.repo), trustedQuery));
  const shownRows = rows.filter((r) => keepRows.has(r.repo));

  function togglePick(repo: string): void {
    setAddError(null);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }

  return (
    <section className="settings-section trust-section">
      <p className="settings-hint">
        Every grant that lets Mission Control act outside this app, in one table. Each column
        is its subsystem's own allowlist - clicking a cell writes there, and the Foreman,
        Workflows, GitHub Inspector and Shipping panels keep working against the same lists.
        Worktrees of a trusted repo count too, wherever they live on disk.
      </p>

      {unknown.length > 0 && (
        <p className="settings-warn trust-unknown">
          Can't reach the daemon for {unknown.join(", ")}, so those grants are unknown, not
          off. The cells below are showing what was last cached, not current state.
        </p>
      )}

      <div className="trust-split">
        <div
          className="trust-pane trust-add"
          data-anchor="trust/add"
          ref={addTourRef}
          role="group"
          aria-labelledby="trust-add-title"
        >
          <div className="trust-pane-head">
            <div className="trust-pane-title-row">
              <h3 className="trust-pane-title" id="trust-add-title">
                Add repositories
              </h3>
              <span className="trust-pane-count">{candidates.length} available</span>
            </div>
            <input
              type="search"
              className="trust-search"
              placeholder="Search repositories…"
              aria-label="Search repositories to add"
              value={pickQuery}
              onChange={(e) => setPickQuery(e.target.value)}
            />
            <div className="trust-pick-actions">
              <Tooltip label="Tick every repository the search is showing">
                <button
                  type="button"
                  className="btn"
                  disabled={shownCandidates.length === 0}
                  onClick={() => setPicked((prev) => new Set([...prev, ...shownCandidates]))}
                >
                  Select all shown
                </button>
              </Tooltip>
              <Tooltip label="Untick every picked repository, including ones the search hides">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={pickedCount === 0}
                  onClick={() => setPicked(new Set())}
                >
                  Clear
                </button>
              </Tooltip>
              <span className="trust-pane-count trust-picked-count">{pickedCount} selected</span>
            </div>
          </div>

          <ul className="trust-pick-list" aria-label="Repositories to add">
            {repoOptionLabels(shownCandidates).map(({ repo, name, hint }) => {
              const on = picked.has(repo);
              return (
                <li key={repo}>
                  <Tooltip label={repo}>
                    <label className={`trust-pick${on ? " is-picked" : ""}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        aria-label={`Select ${repo}`}
                        onChange={() => togglePick(repo)}
                      />
                      <span className="trust-pick-name">{name}</span>
                      {hint && <span className="trust-pick-hint">{hint}</span>}
                    </label>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
          {shownCandidates.length === 0 && (
            <p className="settings-hint trust-pick-empty">
              {repos === null
                ? "Looking for repositories…"
                : repos.length === 0
                  ? "No repositories found in your workspace. Type a path below to add one."
                  : candidates.length === 0
                    ? "Every repository in your workspace is already trusted. Type a path below to add another."
                    : "No repositories match that search."}
            </p>
          )}

          <div className="trust-pane-foot">
            <input
              className="trust-path"
              placeholder="or type a path…"
              aria-label="Repository path"
              value={pathDraft}
              onChange={(e) => {
                setPathDraft(e.target.value);
                setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
              }}
            />
            <p className="trust-defaults">
              <span>New repositories get</span>
              {COLUMNS.map((c) => {
                const on = (DEFAULT_ADD_GRANTS as readonly GrantColumn[]).includes(c.key);
                return (
                  <span
                    key={c.key}
                    className={`trust-grant trust-default ${on ? "is-on" : "is-off"}`}
                  >
                    <span className="trust-grant-dot" aria-hidden />
                    {on ? c.short : `${c.short} off`}
                  </span>
                );
              })}
            </p>
            <Tooltip label="Add the picked repositories and the typed path, each with Foreman, Workflows and GitHub Inspector granted">
              <button
                type="button"
                className="btn btn-primary trust-add-btn"
                disabled={addCount === 0 || adding || awaiting.length > 0}
                onClick={() => void add()}
              >
                {adding
                  ? "Adding…"
                  : addCount === 0
                    ? "Add repositories"
                    : `Add ${addCount} ${addCount === 1 ? "repository" : "repositories"}`}
              </button>
            </Tooltip>
            {awaiting.length > 0 && (
              <p className="settings-hint trust-add-waiting">
                Waiting for {awaiting.join(", ")} to answer before adding, so a new repository
                gets every default grant.
              </p>
            )}
            {addError && <p className="settings-error trust-add-error">{addError}</p>}
          </div>
        </div>

        <div className="trust-pane trust-matrix" data-anchor="trust/matrix" ref={matrixTourRef}>
          <div className="trust-pane-head trust-matrix-head">
            <h3 className="trust-pane-title">Trusted</h3>
            <span className="trust-pane-count">{rows.length}</span>
            <input
              type="search"
              className="trust-search"
              placeholder="Filter trusted…"
              aria-label="Filter trusted repositories"
              value={trustedQuery}
              onChange={(e) => setTrustedQuery(e.target.value)}
            />
          </div>
          <div className="trust-grid" role="table" aria-label="Repository trust grants">
            <div className="trust-h trust-h-repo">Repository</div>
            {COLUMNS.map((c) => (
              <Tooltip key={c.key} label={`${c.label}: ${c.title}`}>
                <div className="trust-h">{c.short}</div>
              </Tooltip>
            ))}
            <div className="trust-h" aria-hidden />
            {shownRows.map((row) => (
              <Fragment key={row.repo}>
                <div className="trust-c trust-repo">
                  <RepositoryName path={row.repo} className="trust-repo-path" />
                  {recent.has(row.repo) && <span className="trust-new-tag">new</span>}
                  <Tooltip label="Choose whether this repository commits its testing settings or keeps them in Mission Control, then an agent audits it for flake-aware testing">
                    <button
                      type="button"
                      className="trust-setup"
                      aria-label={`Set up flake-aware testing for ${row.repo}`}
                      aria-expanded={choosing.has(row.repo)}
                      disabled={setups[row.repo]?.state === "busy"}
                      onClick={() => toggleChoice(row.repo)}
                    >
                      Set up testing
                    </button>
                  </Tooltip>
                </div>
                {COLUMNS.map((c) => cell(row, c))}
                <div className="trust-c trust-remove-c">
                  <Tooltip label={`Remove ${row.repo} - revokes every grant it holds`}>
                    <button
                      type="button"
                      className="trust-remove"
                      aria-label={`Remove every grant for ${row.repo}`}
                      onClick={() => removeRow(row)}
                    >
                      ✕
                    </button>
                  </Tooltip>
                </div>
                {choosing.has(row.repo) && (
                  <TestingSetupChoice
                    repo={row.repo}
                    onStart={(mode) => void startTestingSetup(row.repo, mode)}
                    onCancel={() => toggleChoice(row.repo)}
                  />
                )}
                {setups[row.repo] && (
                  <p
                    className={`trust-row-note${setups[row.repo]!.state === "refused" ? " settings-error" : " settings-hint"}`}
                    role={setups[row.repo]!.state === "refused" ? "alert" : "status"}
                  >
                    {setups[row.repo]!.text}
                  </p>
                )}
              </Fragment>
            ))}
          </div>
          {rows.length === 0 ? (
            <p className="settings-hint trust-empty">
              No repositories yet. Pick some on the left and add them.
            </p>
          ) : (
            shownRows.length === 0 && (
              <p className="settings-hint trust-empty">No trusted repositories match that filter.</p>
            )
          )}
        </div>
      </div>

      {blindSpots.length > 0 && (
        <p className="settings-warn trust-trap-note">
          † YOLO may merge in <WarningRepositoryList repos={blindRepos} />, but GitHub Inspector
          may not review there
          - so no pull request will ever qualify.{" "}
          <Tooltip label="Add these repos to GitHub Inspector's allowlist">
            <button type="button" className="settings-link" onClick={grantReview}>
              Grant the review
            </button>
          </Tooltip>
          , or{" "}
          <Tooltip label="Remove these repos from the merge allowlist">
            <button type="button" className="settings-link" onClick={revokeMerge}>
              revoke the merge
            </button>
          </Tooltip>
          .
        </p>
      )}

      {checkGrants.length > 0 && (
        <p className="settings-warn trust-arm-note">
          ‡ Workflow Commands are on, so a workflow may run <strong>branch-authored code</strong>{" "}
          in <WarningRepositoryList repos={checkRepos} /> with this daemon's filesystem
          authority. It is not a
          sandbox.{" "}
          <Tooltip label="Switch off workflow Commands everywhere">
            <button type="button" className="settings-link" onClick={disarmChecks}>
              Turn Commands off
            </button>
          </Tooltip>
          , or revoke a repo's Workflows cell in the matrix - which also stops Live delivery there.
        </p>
      )}

      {/* The same warning, for the window where the daemon has stopped answering.
          `checkGrants` is empty here whatever the arming says - the rows come from the
          Workflows allowlist, and an unreadable config contributes none - so the confirmed
          note above cannot cover this case, and letting it fall through to nothing is the
          exact self-retiring warning this reading exists to prevent. It names no repository
          because it genuinely does not know which; what it will not do is go quiet. */}
      {checks.armed && !checks.confirmed && (
        <p className="settings-warn trust-arm-note trust-arm-unconfirmed">
          ‡ Workflow Commands were <strong>on</strong> at the last reading, so a workflow may be
          able to run <strong>branch-authored code</strong> with this daemon's filesystem
          authority. Which repositories cannot be listed while Workflows is unreachable, and
          nothing here has been disarmed - only rendered unverifiable.
        </p>
      )}
    </section>
  );
}

/** Each mode as the operator reads it: what it is called, and what the agent will then do. */
const TESTING_SETUP_CHOICES: ReadonlyArray<{
  mode: TestingSetupMode;
  label: string;
  tooltip: string;
  detail: string;
}> = [
  {
    mode: "committed",
    label: "Commit a testing file",
    tooltip: "Keep the testing settings in the repository, reviewed with its pull request",
    detail: "The agent asks you to approve every change in one form, then commits "
      + ".mission/testing.json with CI flake reporting and sets the affected-tests Command.",
  },
  {
    mode: "stored",
    label: "Store settings in Mission Control",
    tooltip: "Keep the testing settings on this machine, applied from a proposal you review",
    detail: "For a repository that will not commit a testing file. The agent changes no file: it "
      + "proposes per-app affected-tests Commands and testing settings, which you apply from the "
      + "preview in Library › Commands.",
  },
];

/**
 * One row's committed-or-stored choice, drawn under the row it belongs to. Nothing is selected
 * when it opens, so Start cannot file a task until the operator has picked a mode.
 */
function TestingSetupChoice({
  repo,
  onStart,
  onCancel,
}: {
  repo: string;
  onStart: (mode: TestingSetupMode) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<TestingSetupMode | null>(null);
  const id = useId();
  return (
    <fieldset className="settings-radios trust-setup-choice" aria-label={`Testing setup for ${repo}`}>
      <legend>Where should this repository's testing settings live?</legend>
      {TESTING_SETUP_CHOICES.map((choice) => (
        <div className="trust-setup-option" key={choice.mode}>
          <Tooltip label={choice.tooltip}>
            <label>
              <input
                type="radio"
                name={`${id}-mode`}
                value={choice.mode}
                checked={mode === choice.mode}
                aria-describedby={`${id}-${choice.mode}`}
                onChange={() => setMode(choice.mode)}
              />
              <span className="trust-setup-option-label">{choice.label}</span>
            </label>
          </Tooltip>
          <p id={`${id}-${choice.mode}`} className="settings-hint">{choice.detail}</p>
        </div>
      ))}
      <div className="trust-setup-actions">
        <Tooltip label="Close this choice without starting a testing setup">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </Tooltip>
        <Tooltip label={mode ? "File and launch the testing setup task" : "Choose where the settings live first"}>
          <button
            type="button"
            className="btn"
            disabled={mode === null}
            onClick={() => mode && onStart(mode)}
          >
            Start testing setup
          </button>
        </Tooltip>
      </div>
    </fieldset>
  );
}

/**
 * The grant-count summary the three grant-consuming panels show where their repo editor used
 * to be, plus the deep-link into Trust. Colocated here because "how many repos hold this grant,
 * and where do you change it" is the matrix's vocabulary, not each panel's.
 */
export function TrustGrantSummary({
  configured,
  count,
  subject,
  onNavigate,
}: {
  /** Whether the daemon has answered. False renders "unknown", never "0 repositories". */
  configured: boolean;
  count: number;
  /**
   * The clause the count is the object of, e.g. "Foreman may send live in". Phrased this
   * way so the count reads correctly at one ("...in 1 repository") as well as many, which a
   * verb-after-the-count phrasing ("1 repository grant...") cannot.
   */
  subject: string;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  return (
    <p className="settings-hint trust-summary">
      {!configured
        ? "Unknown - the daemon hasn't said which repos are trusted. "
        : count === 0
          ? `${subject} no repositories yet. `
          : `${subject} ${count} ${count === 1 ? "repository" : "repositories"}. `}
      Grants live in one place now -{" "}
      <Tooltip label="Open the Trust matrix to change these grants">
        <button
          type="button"
          className="settings-link"
          onClick={() => onNavigate("trust", "trust/matrix")}
        >
          Manage in Trust
        </button>
      </Tooltip>
      .
    </p>
  );
}
