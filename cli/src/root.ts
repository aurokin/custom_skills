// `skm root add|list|remove` — edit the machine config's registered roots.
// `add` validates the path exists and contains a skills/ directory. Reads and
// writes the raw config file (preserving fields it doesn't manage).

import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigError, UsageError } from "./errors";
import { type SkmEnv, configPath, expandTilde } from "./env";
import { repoRoot } from "./machine-config";
import type { MachineConfig, Root, Visibility, VerbOptions, VerbOutcome } from "./types";
import { ExitCode } from "./types";

export async function runRoot(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const sub = opts.args[0];
  switch (sub) {
    case "list":
    case undefined:
      return listRoots(env);
    case "add":
      return addRoot(env, opts.args.slice(1));
    case "remove":
      return removeRoot(env, opts.args[1]);
    default:
      throw new UsageError(`unknown root subcommand: ${sub} (use add|list|remove)`);
  }
}

function listRoots(env: SkmEnv): VerbOutcome {
  const config = readRawConfig(env);
  const roots = config.roots;
  const human =
    roots.length === 0
      ? "No registered roots."
      : roots.map((r) => `  ${r.name.padEnd(16)} ${r.visibility.padEnd(8)} ${r.path}`).join("\n");
  return { exitCode: ExitCode.CLEAN, json: { roots }, human };
}

function addRoot(env: SkmEnv, args: string[]): VerbOutcome {
  const rawPath = args[0];
  if (!rawPath) throw new UsageError("root add requires a path: skm root add <path> [public|private]");
  const visibility = parseVisibility(args[1]);
  const abs = path.resolve(expandTilde(env, rawPath));

  if (!fs.existsSync(abs)) throw new UsageError(`path does not exist: ${abs}`);
  if (!fs.existsSync(path.join(abs, "skills"))) {
    throw new UsageError(`path has no skills/ directory: ${abs}`);
  }

  const config = readRawConfig(env);
  const name = path.basename(abs);
  if (config.roots.some((r) => r.name === name)) {
    throw new UsageError(`a root named '${name}' is already registered`);
  }
  if (config.roots.some((r) => path.resolve(expandTilde(env, r.path)) === abs)) {
    throw new UsageError(`root path already registered: ${abs}`);
  }

  const root: Root = { name, path: abs, visibility };
  config.roots.push(root);
  writeRawConfig(env, config);
  return { exitCode: ExitCode.CLEAN, json: { added: root, roots: config.roots }, human: `Added root '${name}' (${visibility}): ${abs}` };
}

function removeRoot(env: SkmEnv, key: string | undefined): VerbOutcome {
  if (!key) throw new UsageError("root remove requires a name or path");
  const config = readRawConfig(env);
  const keyAbs = path.resolve(expandTilde(env, key));
  const before = config.roots.length;
  config.roots = config.roots.filter(
    (r) => r.name !== key && path.resolve(expandTilde(env, r.path)) !== keyAbs,
  );
  if (config.roots.length === before) throw new UsageError(`no registered root matches '${key}'`);
  writeRawConfig(env, config);
  return { exitCode: ExitCode.CLEAN, json: { removed: key, roots: config.roots }, human: `Removed root '${key}'` };
}

function parseVisibility(v: string | undefined): Visibility {
  if (v === undefined || v === "private") return "private";
  if (v === "public") return "public";
  throw new UsageError(`visibility must be 'public' or 'private', got '${v}'`);
}

/**
 * Read the config file verbatim if present, else seed a fresh config with the
 * built-in public repo root. Root paths are kept as authored (not tilde-expanded)
 * so the written file stays portable.
 */
function readRawConfig(env: SkmEnv): MachineConfig {
  const file = configPath(env);
  if (!fs.existsSync(file)) {
    return { version: 1, roots: [{ name: "public", path: repoRoot(), visibility: "public" }] };
  }
  let parsed: MachineConfig;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MachineConfig;
  } catch (e) {
    throw new ConfigError(`invalid machine config at ${file}: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed.roots)) throw new ConfigError(`machine config at ${file} missing 'roots' array`);
  return parsed;
}

function writeRawConfig(env: SkmEnv, config: MachineConfig): void {
  const file = configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
