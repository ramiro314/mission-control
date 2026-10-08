import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// What `npm config get <key>` prints on Windows, read from npm's own config files instead of
// starting npm.
//
// `npm` on Windows is `npm.cmd`, which needs `cmd.exe` and then starts Node twice: once to find
// the global prefix (`npm-prefix.js`) and once for npm itself. Setup asks on every load, so
// this reads the same files in the same order as `@npmcli/config` (npm 11): the environment,
// then the project, user, global and builtin `npmrc` files, with npm's `${VAR}` replacement,
// its `ini` parsing, and its path rules. `npm config` skips npm's validation pass, so what it
// prints is the parsed value as is.
//
// Wherever npm's answer depends on something this does not model - a launcher other than npm's
// own `npm.cmd`, a workspace root above the project, a value of a type npm would not print
// plainly - the read answers null, and the caller asks npm itself.

export interface NpmConfigContext {
  env: NodeJS.ProcessEnv;
  /** The directory npm would start in, which locates the project config. */
  cwd: string;
  platform: NodeJS.Platform;
  /** `os.homedir()`, which npm uses when `HOME` is unset. */
  homedir: string;
  resolveBinPath(bin: string): Promise<string | null>;
}

const PATH_KEYS = new Set(["prefix", "userconfig", "globalconfig"]);
const BOOLEAN_KEYS = new Set(["global"]);
const STRING_KEYS = new Set(["script-shell", ...PATH_KEYS]);

/** `@npmcli/config`'s `env-replace.js`: `${NAME}` and `${NAME?}`, with backslash escapes. */
const ENV_EXPRESSION = /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g;

function envReplace(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(ENV_EXPRESSION, (original: string, escapes: string, name: string, modifier?: string) => {
    const fallback = modifier === "?" ? "" : `\${${name}}`;
    const value = env[name] !== undefined ? env[name] : fallback;
    if (escapes.length % 2) return original.slice((escapes.length + 1) / 2);
    return escapes.slice(escapes.length / 2) + value;
  });
}

/** `ini`'s `unsafe`: a quoted value through JSON, otherwise cut at the first unescaped `;` or `#`. */
function iniUnsafe(raw: string | undefined): string {
  let value = (raw ?? "").trim();
  const quoted = (value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"));
  if (quoted) {
    if (value.charAt(0) === "'") value = value.slice(1, -1);
    try {
      value = JSON.parse(value) as string;
    } catch {
      // `ini` keeps the text when it is not JSON.
    }
    return value;
  }
  let escaped = false;
  let unescaped = "";
  for (const character of value) {
    if (escaped) {
      unescaped += "\\;#".includes(character) ? character : `\\${character}`;
      escaped = false;
    } else if (";#".includes(character)) {
      break;
    } else if (character === "\\") {
      escaped = true;
    } else {
      unescaped += character;
    }
  }
  if (escaped) unescaped += "\\";
  return unescaped.trim();
}

/** Stands for a list value, which this read never answers. */
const LIST = Symbol("list");

/** One loaded layer: its top-level keys, and the section names that could shadow one. */
interface Layer {
  values: Map<string, unknown>;
  sections: string[];
}

const EMPTY_LAYER: Layer = { values: new Map(), sections: [] };

/** `ini.parse`'s top level, with every key passed through `envReplace` as npm loads it. */
export function parseNpmrc(text: string, env: NodeJS.ProcessEnv): Layer {
  const values = new Map<string, unknown>();
  const sections: string[] = [];
  const line = /^\[([^\]]*)\]\s*$|^([^=]+)(=(.*))?$/i;
  for (const entry of text.split(/[\r\n]+/g)) {
    if (!entry || /^\s*[;#]/.test(entry) || /^\s*$/.test(entry)) continue;
    const match = line.exec(entry);
    if (!match) continue;
    if (match[1] !== undefined) {
      sections.push(envReplace(iniUnsafe(match[1]), env));
      continue;
    }
    // Everything after the first section header belongs to a section.
    if (sections.length > 0) continue;
    const rawKey = iniUnsafe(match[2]);
    const isList = rawKey.length > 2 && rawKey.endsWith("[]");
    const key = isList ? rawKey.slice(0, -2) : rawKey;
    if (key === "__proto__") continue;
    const rawValue = match[3] ? iniUnsafe(match[4]) : true;
    const value = rawValue === "true" || rawValue === "false" || rawValue === "null"
      ? JSON.parse(rawValue) as unknown
      : rawValue;
    // `ini` keeps appending to a key that was ever a list.
    values.set(envReplace(key, env), isList || values.get(envReplace(key, env)) === LIST ? LIST : value);
  }
  return { values, sections };
}

/** The environment layer: every non-empty `npm_config_*` variable, named as npm names it. */
function environmentLayer(env: NodeJS.ProcessEnv): Layer {
  const values = new Map<string, unknown>();
  for (const [name, value] of Object.entries(env)) {
    if (!/^npm_config_/i.test(name) || value === "" || value === undefined) continue;
    let key = name.slice("npm_config_".length);
    if (!key.startsWith("//")) key = key.replace(/(?!^)_/g, "-").toLowerCase();
    values.set(envReplace(key, env), value);
  }
  return { values, sections: [] };
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/** A config file as npm loads it: missing or unreadable is an empty layer. */
async function fileLayer(path: string, env: NodeJS.ProcessEnv): Promise<Layer> {
  const text = await readFile(path, "utf8").catch(() => null);
  return text === null ? EMPTY_LAYER : parseNpmrc(text, env);
}

class Unmodeled extends Error {}

/** `walk-up-path`: `start` and then each parent, through the root. */
function* walkUp(start: string): Generator<string> {
  for (let path = resolve(start); ;) {
    yield path;
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
  }
}

/** npm's file and environment layers, highest priority first. */
const LAYER_ORDER = ["env", "project", "user", "global", "builtin"] as const;
type LayerName = (typeof LAYER_ORDER)[number];

class NpmConfig {
  readonly layers: Record<LayerName, Layer> = {
    env: EMPTY_LAYER,
    project: EMPTY_LAYER,
    user: EMPTY_LAYER,
    global: EMPTY_LAYER,
    builtin: EMPTY_LAYER,
  };
  private readonly home: string;

  constructor(
    private readonly context: NpmConfigContext,
    private readonly defaults: ReadonlyMap<string, unknown>,
  ) {
    this.home = context.env.HOME || context.homedir;
  }

  /** `#get(key)` with the value parsed as `parseField` parses it, or undefined when nothing sets it. */
  get(key: string): unknown {
    for (const name of LAYER_ORDER) {
      const layer = this.layers[name];
      if (layer.sections.some((section) => section === key || section.startsWith(`${key}.`))) {
        throw new Unmodeled(`a section named ${key}`);
      }
      if (layer.values.has(key)) return this.parse(key, layer.values.get(key));
    }
    if (key === "globalconfig") return resolve(this.path("prefix"), "etc/npmrc");
    return this.parse(key, this.defaults.get(key));
  }

  /** A path-typed value, which npm resolves; any other type would make npm throw. */
  path(key: string): string {
    const value = this.get(key);
    if (typeof value !== "string") throw new Unmodeled(`${key} is not a path`);
    return value;
  }

  private parse(key: string, value: unknown): unknown {
    if (value === LIST) throw new Unmodeled(`${key} is a list`);
    if (typeof value !== "string") return value;
    let text = value.trim();
    const isString = STRING_KEYS.has(key);
    if (BOOLEAN_KEYS.has(key) && text === "") return true;
    if (!isString) {
      switch (text) {
        case "true": return true;
        case "false": return false;
        case "null": return null;
        case "undefined": return undefined;
      }
    }
    text = envReplace(text, this.context.env);
    if (!PATH_KEYS.has(key)) return text;
    const homePattern = this.context.platform === "win32" ? /^~(\/|\\)/ : /^~\//;
    return homePattern.test(text) && this.home
      ? resolve(this.home, text.slice(2))
      : resolve(this.context.cwd, text);
  }
}

/** Every config layer npm started from `npmPath` under `execPath` loads, in npm's load order. */
async function loadConfig(context: NpmConfigContext, npmPath: string, execPath: string): Promise<NpmConfig> {
  const { env } = context;
  const config = new NpmConfig(context, new Map<string, unknown>([
    ["prefix", env.PREFIX || dirname(execPath)],
    ["userconfig", "~/.npmrc"],
    ["global", false],
    ["location", "user"],
    ["script-shell", null],
  ]));
  config.layers.builtin = await fileLayer(resolve(npmPath, "npmrc"), env);
  config.layers.env = environmentLayer(env);

  // The project is the nearest directory holding package.json or node_modules.
  const isGlobal = Boolean(config.get("global")) || config.get("location") === "global";
  let localPrefix: string | null = null;
  for (const directory of walkUp(context.cwd)) {
    const hasPackageJson = await isFile(join(directory, "package.json"));
    if (!localPrefix && (hasPackageJson || await isDirectory(join(directory, "node_modules")))) {
      localPrefix = directory;
      if (isGlobal) break;
      continue;
    }
    if (localPrefix && hasPackageJson) {
      // npm makes a workspace root above the project the project instead; not modeled.
      const manifest = await readFile(join(directory, "package.json"), "utf8")
        .then((text) => JSON.parse(text) as { workspaces?: unknown })
        .catch(() => null);
      if (manifest?.workspaces) throw new Unmodeled(`a workspace root at ${directory}`);
    }
  }
  localPrefix ??= context.cwd;

  if (config.get("global") !== true && config.get("location") !== "global") {
    // Skipped when it is the user config, as from a home directory holding node_modules.
    const projectFile = resolve(localPrefix, ".npmrc");
    if (projectFile !== config.get("userconfig")) config.layers.project = await fileLayer(projectFile, env);
  }
  config.layers.user = await fileLayer(config.path("userconfig"), env);
  config.layers.global = await fileLayer(config.path("globalconfig"), env);
  return config;
}

/**
 * What `npm config get <key>` prints for the `npm` found on PATH, or null when this read does
 * not model that npm's setup exactly and npm itself must be asked.
 */
export async function npmConfigGet(key: string, context: NpmConfigContext): Promise<string | null> {
  if (context.platform !== "win32") return null;
  try {
    // npm's own `npm.cmd`: Node beside it, npm under `node_modules\npm`, and a hand-off to
    // the npm installed under the global prefix when there is one.
    const launcher = await context.resolveBinPath("npm");
    if (!launcher || basename(launcher).toLowerCase() !== "npm.cmd") return null;
    const directory = dirname(launcher);
    const shim = await readFile(launcher, "utf8");
    if (!/npm-prefix\.js/i.test(shim)) return null;
    const execPath = join(directory, "node.exe");
    let npmPath = join(directory, "node_modules", "npm");
    if (!await isFile(execPath) || !await isFile(join(npmPath, "bin", "npm-prefix.js"))) return null;

    let config = await loadConfig(context, npmPath, execPath);
    const prefixNpm = join(config.path("prefix"), "node_modules", "npm");
    if (prefixNpm !== npmPath && await isFile(join(prefixNpm, "bin", "npm-cli.js"))) {
      npmPath = prefixNpm;
      config = await loadConfig(context, npmPath, execPath);
    }
    const value = config.get(key);
    if (value !== null && typeof value === "object") return null;
    return `${value}`;
  } catch {
    // `Unmodeled`, or a file npm might read differently: npm answers instead.
    return null;
  }
}
