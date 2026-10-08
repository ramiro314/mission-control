import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import test from "node:test";

import { npmConfigGet, parseNpmrc, type NpmConfigContext } from "../src/server/setup/npm-config.ts";
import { osHomeEnv } from "./helpers/os-home.ts";

// The npm-config read on every platform: the npm it models is Windows' `npm.cmd`, but every
// rule it applies is npm's own, so the cases below hold it to npm's own config loader, run
// in-process as a Windows npm on fixture files. The last case holds it to the real `npm.cmd`.

const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-npm-config-")));
after(() => rmSync(root, { recursive: true, force: true }));

let fixtures = 0;

interface Fixture {
  root: string;
  home: string;
  project: string;
  prefix: string;
  nodeDir: string;
  npmPath: string;
  env: NodeJS.ProcessEnv;
  context(overrides?: Partial<NpmConfigContext>): NpmConfigContext;
  write(path: string, text: string): void;
}

/** A Windows-shaped Node install (`npm.cmd`, `node.exe`, `node_modules\npm`), a home, and a project. */
function fixture(): Fixture {
  const base = join(root, String(fixtures++));
  const home = join(base, "home");
  const project = join(base, "work", "project");
  const prefix = join(base, "prefix");
  const nodeDir = join(base, "nodejs");
  const npmPath = join(nodeDir, "node_modules", "npm");
  for (const directory of [home, project, prefix, dirname(npmPath)]) mkdirSync(directory, { recursive: true });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  write(join(nodeDir, "npm.cmd"), "SET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"\r\n");
  write(join(nodeDir, "node.exe"), "");
  write(join(npmPath, "bin", "npm-prefix.js"), "");
  write(join(project, "package.json"), "{}");
  const env: NodeJS.ProcessEnv = {
    ...osHomeEnv(home),
    PREFIX: prefix,
    APPDATA: join(base, "appdata"),
  };
  return {
    root: base,
    home,
    project,
    prefix,
    nodeDir,
    npmPath,
    env,
    write,
    context: (overrides = {}) => ({
      env,
      cwd: project,
      platform: "win32",
      homedir: home,
      resolveBinPath: async (bin) => bin === "npm" ? join(nodeDir, "npm.cmd") : null,
      ...overrides,
    }),
  };
}

// ---- held to the real npm ----

interface NpmConfigLoader {
  load(options: { env: NodeJS.ProcessEnv; cwd: string; npmPath: string; execPath: string }): Promise<unknown>;
}

/** `@npmcli/config` from the npm package running this Node: the loader `npm config get` reads through. */
function npmConfigLoader(): NpmConfigLoader | null {
  const npmPackage = [
    join(dirname(process.execPath), "node_modules", "npm"),
    join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm"),
  ].find((candidate) => existsSync(join(candidate, "node_modules", "@npmcli", "config", "lib", "definitions", "index.js")));
  if (!npmPackage) return null;
  const require = createRequire(join(npmPackage, "package.json"));
  const Config = require("@npmcli/config") as new (options: object) => { load(): Promise<void>; get(key: string): unknown };
  const { definitions, flatten, shorthands } = require("@npmcli/config/lib/definitions") as Record<string, unknown>;
  return {
    async load({ env, cwd, npmPath, execPath }) {
      // As `npm-prefix.js` builds it, on win32; `npm config` skips validation.
      const config = new Config({ npmPath, argv: [], definitions, flatten, shorthands, env, cwd, execPath, platform: "win32", warn: false });
      await config.load();
      return config.get("script-shell");
    },
  };
}

const npmLoader = npmConfigLoader();

interface OracleCase {
  name: string;
  files?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  /** Relative to the project. */
  cwd?: string;
}

const ORACLE_CASES: OracleCase[] = [
  { name: "nothing set" },
  { name: "the user config, unquoted with backslashes", files: { "home/.npmrc": "script-shell=C:\\Program Files\\Git\\bin\\bash.exe\n" } },
  { name: "the user config, double-quoted JSON", files: { "home/.npmrc": "script-shell=\"C:\\\\Git\\\\bin\\\\bash.exe\"\n" } },
  { name: "the user config, single-quoted", files: { "home/.npmrc": "script-shell='C:\\Git\\bin\\bash.exe'\n" } },
  { name: "a trailing comment and spaces", files: { "home/.npmrc": "  script-shell  =  /usr/bin/bash ; Git Bash\r\n" } },
  { name: "an escaped comment character", files: { "home/.npmrc": "script-shell=/opt/a\\;b/bash\n" } },
  { name: "${VAR} replacement", files: { "home/.npmrc": "script-shell=${MC_TEST_GIT}\\bin\\bash.exe\n" }, env: { MC_TEST_GIT: "D:\\Git" } },
  { name: "an unset ${VAR?}", files: { "home/.npmrc": "script-shell=${MC_TEST_UNSET?}bash\n" } },
  { name: "the literal true", files: { "home/.npmrc": "script-shell=true\n" } },
  { name: "the literal null", files: { "home/.npmrc": "script-shell=null\n" } },
  { name: "an empty value", files: { "home/.npmrc": "script-shell=\n" } },
  { name: "a key with no value", files: { "home/.npmrc": "script-shell\n" } },
  { name: "a later duplicate wins", files: { "home/.npmrc": "script-shell=/first/bash\nscript-shell=/second/bash\n" } },
  { name: "a key inside a section", files: { "home/.npmrc": "[section]\nscript-shell=/sectioned/bash\n" } },
  { name: "the project config over the user config", files: { "home/.npmrc": "script-shell=/user/bash\n", "work/project/.npmrc": "script-shell=/project/bash\n" } },
  {
    name: "the environment over the project config",
    files: { "work/project/.npmrc": "script-shell=/project/bash\n" },
    env: { npm_config_script_shell: "/env/bash" },
  },
  { name: "an upper-case environment variable", env: { NPM_CONFIG_SCRIPT_SHELL: "/upper/bash" } },
  { name: "an empty environment variable is ignored", files: { "home/.npmrc": "script-shell=/user/bash\n" }, env: { npm_config_script_shell: "" } },
  { name: "the global config under the prefix", files: { "prefix/etc/npmrc": "script-shell=/global/bash\n" } },
  { name: "the user config over the global config", files: { "prefix/etc/npmrc": "script-shell=/global/bash\n", "home/.npmrc": "script-shell=/user/bash\n" } },
  { name: "a relocated user config", files: { "home/other.npmrc": "script-shell=/other/bash\n" }, env: { npm_config_userconfig: "~/other.npmrc" } },
  { name: "a user config the project relocates", files: { "work/project/.npmrc": "userconfig=~/other.npmrc\n", "home/other.npmrc": "script-shell=/other/bash\n" } },
  { name: "a global config the user config relocates", files: { "home/.npmrc": "globalconfig=${HOME}/global.npmrc\n", "home/global.npmrc": "script-shell=/relocated/bash\n" } },
  { name: "a prefix the user config moves", files: { "home/.npmrc": "prefix=~/moved\n", "home/moved/etc/npmrc": "script-shell=/moved/bash\n" } },
  { name: "the builtin npmrc beside npm", files: { "nodejs/node_modules/npm/npmrc": "script-shell=/builtin/bash\n" } },
  { name: "a builtin prefix locates the global config", files: { "nodejs/node_modules/npm/npmrc": "prefix=${APPDATA}/npm\n", "appdata/npm/etc/npmrc": "script-shell=/appdata/bash\n" } },
  { name: "without PREFIX, the global config beside node.exe", files: { "nodejs/etc/npmrc": "script-shell=/node-dir/bash\n" }, env: { PREFIX: "" } },
  { name: "global mode skips the project config", files: { "work/project/.npmrc": "script-shell=/project/bash\n" }, env: { npm_config_global: "true" } },
  { name: "the project found from a subdirectory", files: { "work/project/.npmrc": "script-shell=/project/bash\n" }, cwd: "src/deep" },
  {
    name: "the nearest node_modules marks the project",
    files: { "work/project/.npmrc": "script-shell=/outer/bash\n", "work/project/inner/node_modules/.keep": "", "work/project/inner/.npmrc": "script-shell=/inner/bash\n" },
    cwd: "inner/src",
  },
];

for (const oracle of ORACLE_CASES) {
  test(`script-shell matches npm's own config loader: ${oracle.name}`, {
    skip: npmLoader ? false : "the npm package running this Node has no @npmcli/config",
  }, async () => {
    const f = fixture();
    for (const [path, text] of Object.entries(oracle.files ?? {})) f.write(join(f.root, path), text);
    const cwd = join(f.project, oracle.cwd ?? "");
    mkdirSync(cwd, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...f.env, ...oracle.env };
    // `npm config get` prints the value as a template string does.
    const npm = `${await npmLoader!.load({ env: { ...env }, cwd, npmPath: f.npmPath, execPath: join(f.nodeDir, "node.exe") })}`;
    assert.equal(await npmConfigGet("script-shell", f.context({ env, cwd })), npm);
  });
}

// ---- the launcher, and what the read leaves to npm ----

test("an npm installed under the global prefix takes over, with its own builtin npmrc", async () => {
  const f = fixture();
  f.write(join(f.npmPath, "npmrc"), "script-shell=/bundled/bash\n");
  f.write(join(f.prefix, "node_modules", "npm", "bin", "npm-cli.js"), "");
  f.write(join(f.prefix, "node_modules", "npm", "npmrc"), "script-shell=/upgraded/bash\n");
  assert.equal(await npmConfigGet("script-shell", f.context()), "/upgraded/bash");
});

test("the read leaves to npm every setup it does not model", async () => {
  const cases: Array<[string, (f: Fixture) => Partial<NpmConfigContext> | void]> = [
    ["a host other than win32", () => ({ platform: "linux" })],
    ["no npm on PATH", () => ({ resolveBinPath: async () => null })],
    ["an npm launcher that is not npm.cmd", (f) => {
      f.write(join(f.nodeDir, "npm.exe"), "");
      return { resolveBinPath: async () => join(f.nodeDir, "npm.exe") };
    }],
    ["an npm.cmd that is not npm's own", (f) => { f.write(join(f.nodeDir, "npm.cmd"), "@\"%~dp0\\node.exe\" \"%~dp0\\node_modules\\npm\\bin\\npm-cli.js\" %*\r\n"); }],
    ["no node.exe beside npm.cmd", (f) => { rmSync(join(f.nodeDir, "node.exe")); }],
    ["a workspace root above the project", (f) => { f.write(join(f.root, "work", "package.json"), "{\"workspaces\":[\"project\"]}"); }],
    ["a list value", (f) => { f.write(join(f.home, ".npmrc"), "script-shell[]=/a/bash\n"); }],
    ["a section named after the key", (f) => { f.write(join(f.project, ".npmrc"), "[script-shell]\nx=1\n"); }],
    ["a path setting that is not a path", (f) => { f.write(join(f.project, ".npmrc"), "userconfig=null\n"); }],
  ];
  for (const [name, change] of cases) {
    const f = fixture();
    f.write(join(f.home, ".npmrc"), "script-shell=/user/bash\n");
    assert.equal(await npmConfigGet("script-shell", f.context()), "/user/bash", `${name}: modeled before the change`);
    assert.equal(await npmConfigGet("script-shell", f.context(change(f) ?? {})), null, name);
  }
});

test("parseNpmrc keeps the top level, a list as a list, and the sections that could shadow a key", () => {
  const layer = parseNpmrc("a=1\n; comment\n# comment\nb[]=x\nb[]=y\nc=true\n=skipped\n[s]\nd=2\n", {});
  assert.deepEqual([...layer.values.keys()], ["a", "b", "c"]);
  assert.equal(layer.values.get("a"), "1");
  assert.equal(layer.values.get("c"), true);
  assert.equal(typeof layer.values.get("b"), "symbol");
  assert.deepEqual(layer.sections, ["s"]);
});

// ---- the real machine ----

const cmd = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
const noCmd = existsSync(cmd) ? false : "cmd.exe is not installed";

test("on Windows, the read reports exactly what npm config get reports, without asking npm", { skip: noCmd }, async () => {
  const { resolveBinPath } = await import("../src/server/util/exec.ts");
  const { homedir } = await import("node:os");
  const read = await npmConfigGet("script-shell", {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    homedir: homedir(),
    resolveBinPath,
  });
  const npm = execFileSync(cmd, ["/d", "/s", "/c", "npm config get script-shell"], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert.notEqual(read, null, "this machine's npm is not one the read models, so Setup still starts npm");
  assert.equal(read, npm.replace(/\r?\n$/, ""));
});
