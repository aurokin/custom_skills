// Filesystem scanning: pure, read-only inspection of what currently sits at a
// placement target (absent / adopted / owned / foreign) and enumeration of
// entries in agent dirs to hunt for artifacts skm did not place. Never mutates.
// Symlinks are only resolved outward for hashing when the resolution is recorded
// in `resolvedTarget`. Owned by the status/doctor team.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type SkmEnv, expandTilde } from "./env";
import { dirPath } from "./registry";
import type { DriftFinding, Registry, StateFile, TargetStatus } from "./types";

/**
 * A single filesystem entry as observed on disk. NOTE: not yet in types.ts —
 * integrator should hoist `ScanEntry` there. `kind: "absent"` only arises from
 * point lookups (scanTargets); directory listings never yield it.
 */
export interface ScanEntry {
  /** basename of the entry. */
  name: string;
  /** absolute path of the entry. */
  path: string;
  kind: "symlink" | "dir" | "file" | "absent";
  /** raw fs.readlink target (symlinks only). */
  linkTarget?: string;
  /** realpath resolution (symlinks that resolve; absent when broken). */
  resolvedTarget?: string;
  /** true for a symlink whose target does not resolve. */
  broken?: boolean;
  /** sha256 (hex) of the entry's SKILL.md, if one exists and is readable. */
  sha256OfSkillMd?: string;
}

/** sha256 (lowercase hex) of `<dir>/SKILL.md`, or undefined if unreadable/absent. */
function hashSkillMd(dir: string): string | undefined {
  try {
    const content = fs.readFileSync(path.join(dir, "SKILL.md"));
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return undefined;
  }
}

/** Inspect a single path (tilde-expanded). Read-only; never follows a link silently. */
export function scanEntry(env: SkmEnv, entryPath: string): ScanEntry {
  const abs = expandTilde(env, entryPath);
  const name = path.basename(abs);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return { name, path: abs, kind: "absent" };
  }

  if (st.isSymbolicLink()) {
    const entry: ScanEntry = { name, path: abs, kind: "symlink" };
    try {
      entry.linkTarget = fs.readlinkSync(abs);
    } catch {
      /* unreadable link value; leave undefined */
    }
    try {
      entry.resolvedTarget = fs.realpathSync(abs);
    } catch {
      entry.broken = true;
      return entry;
    }
    entry.sha256OfSkillMd = hashSkillMd(entry.resolvedTarget);
    return entry;
  }

  if (st.isDirectory()) {
    return { name, path: abs, kind: "dir", sha256OfSkillMd: hashSkillMd(abs) };
  }
  return { name, path: abs, kind: "file" };
}

/** List every entry directly under `dirPath`. Returns [] when the dir is absent. */
export function scanDir(env: SkmEnv, dir: string): ScanEntry[] {
  const abs = expandTilde(env, dir);
  let names: string[];
  try {
    names = fs.readdirSync(abs);
  } catch {
    return [];
  }
  return names.sort().map((n) => scanEntry(env, path.join(abs, n)));
}

/** Scan every registry directory that exists on disk, keyed by directory id. */
export function scanRegistryDirs(env: SkmEnv, registry: Registry): Record<string, ScanEntry[]> {
  const out: Record<string, ScanEntry[]> = {};
  for (const dirId of Object.keys(registry.directories)) {
    const abs = dirPath(env, registry, dirId);
    if (fs.existsSync(abs)) out[dirId] = scanDir(env, abs);
  }
  return out;
}

/** Point-lookup several placement targets at once (order preserved). */
export function scanTargets(env: SkmEnv, placements: { path: string }[]): ScanEntry[] {
  return placements.map((p) => scanEntry(env, p.path));
}

/** Resolve a path to a canonical absolute form for comparison (realpath when it exists). */
function realOf(env: SkmEnv, p: string): string {
  const abs = expandTilde(env, p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return path.resolve(abs);
  }
}

/**
 * Classify the on-disk state of `targetPath` given the source it should point at.
 * "adopted" = a symlink already resolving to expectedSource (adopt into state).
 * State-free: "owned" (a recorded, correct placement) is a determination the
 * caller makes by cross-referencing state; this function only distinguishes
 * absent / adopted / foreign from the filesystem alone.
 */
export function classifyTarget(
  env: SkmEnv,
  targetPath: string,
  expectedSource: string,
): TargetStatus {
  const entry = scanEntry(env, targetPath);
  if (entry.kind === "absent") return "absent";
  if (entry.kind === "symlink" && !entry.broken && entry.resolvedTarget) {
    return realOf(env, entry.resolvedTarget) === realOf(env, expectedSource) ? "adopted" : "foreign";
  }
  return "foreign";
}

/**
 * Walk every registry dir that exists and report entries skm does not own.
 * An entry is owned iff its resolved absolute path matches a placement recorded
 * in state; everything else is `foreign` (broken links included, flagged in
 * detail). Drift of owned placements (missing/stale/modified) is status.ts's job.
 */
export function scanForForeign(
  env: SkmEnv,
  registry: Registry,
  state: StateFile,
): DriftFinding[] {
  const owned = new Set<string>();
  for (const artifact of Object.values(state.artifacts)) {
    for (const placement of artifact.placements) {
      owned.add(path.resolve(expandTilde(env, placement.path)));
    }
  }

  const findings: DriftFinding[] = [];
  const dirs = scanRegistryDirs(env, registry);
  for (const entries of Object.values(dirs)) {
    for (const entry of entries) {
      if (owned.has(path.resolve(entry.path))) continue;
      const detail =
        entry.kind === "symlink"
          ? entry.broken
            ? `broken symlink -> ${entry.linkTarget ?? "?"}`
            : `unmanaged symlink -> ${entry.resolvedTarget}`
          : `unmanaged ${entry.kind}`;
      findings.push({ drift: "foreign", path: entry.path, detail });
    }
  }
  return findings;
}
