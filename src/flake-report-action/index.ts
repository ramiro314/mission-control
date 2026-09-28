import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderFlakeSummary, type FlakeReport } from "@shared/flake-report.ts";
import { TESTING_CONFIG_PATH } from "@shared/testing-config.ts";
import { runContextFrom } from "./context.ts";
import { gitHubClient, type FetchLike } from "./github.ts";
import { publish, type PerJobReport } from "./publish.ts";
import { emptyReport, readPlaywright, rerunJUnit, type SpawnCommand } from "./rerun.ts";
import { FLAKE_REPORT_ACTION_VERSION } from "./version.ts";

// The mission-flake-report action's entry point. GitHub Actions runs the bundle generated from
// this file (`npm run build:flake-report-action`); it uses only Node built-ins and `fetch`.

/** An action input, the way the runner passes it: `INPUT_<NAME>` with the name upper-cased. */
function input(name: string): string {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

function requireInput(name: string): string {
  const value = input(name);
  if (!value) throw new Error(`The \`${name}\` input is required in this mode.`);
  return value;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function appendSummary(markdown: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, `${markdown}\n`);
  else console.log(markdown);
}

function setOutput(name: string, value: string | number): void {
  const path = process.env.GITHUB_OUTPUT;
  if (path) appendFileSync(path, `${name}=${value}\n`);
}

/** Set in the rerun's environment, so a test (or the CI proof's deliberate flake) can tell. */
const RERUN_ENV = "MISSION_FLAKE_RERUN";

const spawnInherit: SpawnCommand = (argv, cwd) =>
  new Promise((resolve) => {
    const [command = "", ...args] = argv;
    const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, [RERUN_ENV]: "1" } });
    child.on("error", (err) => {
      console.error(`Could not start ${command}: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });

function readEvent(): unknown {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function jsonFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...jsonFilesUnder(path));
    else if (entry.endsWith(".json")) found.push(path);
  }
  return found;
}

async function rerunMode(): Promise<number> {
  const ctx = runContextFrom(process.env, readEvent());
  const cwd = process.cwd();
  const job = input("job") || undefined;
  const reportPath = requireInput("report");
  const playwrightJson = input("playwright-json");
  let classified;
  if (playwrightJson) {
    classified = readPlaywright(playwrightJson, { cwd, job });
  } else {
    const exitText = input("exit-code");
    const exitCode = exitText === "" ? null : Number.parseInt(exitText, 10);
    const template = input("rerun-command");
    const scratch = join(process.env.RUNNER_TEMP || tmpdir(), `mission-flake-rerun-${process.pid}`);
    mkdirSync(scratch, { recursive: true });
    classified = await rerunJUnit({
      junitPath: requireInput("junit"),
      exitCode: exitCode !== null && Number.isNaN(exitCode) ? null : exitCode,
      template: template ? template.split(/\s+/) : null,
      rerunJUnitPath: join(scratch, "rerun.xml"),
      runner: input("runner") || "junit",
      job,
      cwd,
      spawn: spawnInherit,
    });
  }
  const report: FlakeReport = { ...emptyReport(ctx), ...classified };
  writeJson(reportPath, report);
  setOutput("flakes", report.flakes.length);
  setOutput("failures", report.failures.length);
  if (report.flakes.length + report.failures.length + report.errors.length > 0) {
    appendSummary(renderFlakeSummary(report));
  }
  for (const flake of report.flakes) console.log(`::warning title=Flaky test::${flake.name} (${flake.file}) failed, then passed on rerun.`);
  const failed = report.failures.length > 0 || report.errors.length > 0;
  console.log(`${report.flakes.length} flaky, ${report.failures.length} failed twice, ${report.errors.length} unclassified.`);
  return failed ? 1 : 0;
}

async function publishMode(): Promise<number> {
  const ctx = runContextFrom(process.env, readEvent());
  const dir = requireInput("reports");
  const reports: PerJobReport[] = jsonFilesUnder(dir).map((path) => ({ source: path, text: readFileSync(path, "utf8") }));
  const configPath = input("config") || TESTING_CONFIG_PATH;
  const client = gitHubClient({
    apiUrl: ctx.apiUrl,
    token: input("github-token") || process.env.GITHUB_TOKEN || "",
    fetch: globalThis.fetch as unknown as FetchLike,
  });
  const result = await publish({
    ctx,
    reports,
    configText: existsSync(configPath) ? readFileSync(configPath, "utf8") : null,
    client,
    now: new Date(),
  });
  const out = input("report");
  if (out) writeJson(out, result.report);
  setOutput("flakes", result.report.flakes.length);
  setOutput("conclusion", result.conclusion);
  appendSummary(`${result.summary}\n${result.notes.map((note) => `> ${note}`).join("\n>\n")}`);
  for (const note of result.notes) console.log(note);
  return 0;
}

async function main(): Promise<number> {
  console.log(`mission-flake-report ${FLAKE_REPORT_ACTION_VERSION}`);
  const mode = input("mode");
  if (mode === "rerun") return rerunMode();
  if (mode === "publish") return publishMode();
  throw new Error(`Unknown mode "${mode}": expected "rerun" or "publish".`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`::error title=Flake report::${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
