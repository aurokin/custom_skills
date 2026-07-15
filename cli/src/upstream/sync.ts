// Pure resolution path for `skm upstream sync` (ADR 0014 decision 4), ported from
// install-repro-skills.sh + the globalSpecs side of lib/catalog.sh. Given the
// curated global specs, the validated `.skills.local.json` overrides, the agents
// list, and the currently installed global skill names, this module computes the
// sync plan: which installed names are stale (removed with `-a` narrowed to
// non-Hermes agents), which are preserved, and which desired skills are missing
// (added per repo batch, with the OpenClaw / diffwarden extra flags). It also
// carries the two broken-symlink sweeps (owned dirs unconditionally; the Hermes
// dir only for links resolving into our own targets).
//
// NOTHING here writes skm's state.json: upstream installs are never skm-owned
// (ADR 0014 ownership boundary) — skm diffs desired state and orchestrates; the
// `skills` CLI fetches and places.

import * as fs from "node:fs";
import * as path from "node:path";
import { SPEC_LINE } from "../catalog-specs";
import {
  type UpstreamEnumerator,
  dedupe,
  expandFullRepoSpecs,
  filterExcludedSpecs,
  resolveExcludedSpecs,
  specRepo,
  specSkill,
} from "../deploy/resolve";
import type { LocalSkillsConfig } from "../deploy/local-config";

// ── desired-state resolution (load_global_specs + exclude expansion) ─────────

/** read_specs_file_into_array for the global-specs file: invalid lines fail loudly. */
export function readGlobalSpecsFile(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`Missing global specs file: ${file}`);
  }
  const specs: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "" || line.startsWith("#")) continue;
    if (!SPEC_LINE.test(line)) throw new Error(`Invalid skill spec in ${file}:${i + 1}: ${line}`);
    specs.push(line);
  }
  return specs;
}

export interface ResolvedGlobalSpecs {
  /** Fully explicit desired specs (whole-repo specs expanded, excludes filtered). */
  desiredSpecs: string[];
  /** Explicit form of every exclude that applied (feeds the audit's ignore lists). */
  resolvedExcludedSpecs: string[];
}

/**
 * load_global_specs + expand_full_repo_specs + exclude resolution from main():
 * catalog file specs + `.skills.local.json` globalSpecs (deduped), whole-repo
 * specs expanded through `enumerate`, then excludeGlobalSpecs resolved against
 * the expansion and filtered out.
 */
export function resolveDesiredGlobalSpecs(
  globalSpecsFile: string,
  local: LocalSkillsConfig,
  enumerate: UpstreamEnumerator,
): ResolvedGlobalSpecs {
  const specs = dedupe([...readGlobalSpecsFile(globalSpecsFile), ...local.globalSpecs]);
  const expanded = expandFullRepoSpecs(specs, enumerate);
  const excluded = dedupe([...local.excludeGlobalSpecs]);
  const resolvedExcludedSpecs = resolveExcludedSpecs(excluded, expanded);
  const desiredSpecs = filterExcludedSpecs(expanded, resolvedExcludedSpecs);
  return { desiredSpecs, resolvedExcludedSpecs };
}

// ── sync plan (remove-stale / add-missing) ───────────────────────────────────

/** Per-repo extra `skills add` flags, verbatim from install-repro-skills.sh:
 *  OpenClaw hosts unverified community submissions (explicit risk acknowledgement);
 *  diffwarden keeps its consumable skill below skills/diffwarden/ (full-depth discovery). */
const ADD_EXTRA_ARGS: Record<string, string[]> = {
  "openclaw/openclaw": ["--dangerously-accept-openclaw-risks"],
  "aurokin/diffwarden": ["--full-depth"],
};

export interface SyncAddBatch {
  repo: string;
  skills: string[];
  extraArgs: string[];
}

export interface SyncPlan {
  /** Installed names to remove (sorted; bash iterates an unordered hash). */
  removals: string[];
  /** Installed names protected by preserveGlobalSkillNames (echoed, never removed). */
  preservedInstalled: string[];
  /** Hermes-only mode: stale removal is skipped entirely (installs are add-only). */
  skipStaleRemoval: boolean;
  /** Missing desired skills grouped per repo, in desired-spec order. */
  addBatches: SyncAddBatch[];
}

/**
 * The remove-stale / add-missing diff of main(): an installed name survives if it
 * is preserved or expected by any desired spec (names are repo-agnostic, exactly
 * like bash's `desired_names` set); a desired name missing from the installs is
 * added from its spec's repo.
 */
export function buildSyncPlan(input: {
  desiredSpecs: string[];
  preservedNames: string[];
  installedNames: string[];
  nonHermesAgents: string[];
}): SyncPlan {
  const desiredNames = new Set(input.desiredSpecs.map((s) => specSkill(s)));
  const preservedNames = new Set(input.preservedNames);
  const installed = new Set(input.installedNames);

  const skipStaleRemoval = input.nonHermesAgents.length === 0;
  const removals: string[] = [];
  const preservedInstalled: string[] = [];
  if (!skipStaleRemoval) {
    for (const name of [...installed].sort()) {
      if (preservedNames.has(name)) {
        preservedInstalled.push(name);
        continue;
      }
      if (!desiredNames.has(name)) removals.push(name);
    }
  }

  const addBatches: SyncAddBatch[] = [];
  const byRepo = new Map<string, SyncAddBatch>();
  for (const spec of input.desiredSpecs) {
    const name = specSkill(spec);
    if (installed.has(name)) continue;
    const repo = specRepo(spec);
    let batch = byRepo.get(repo);
    if (!batch) {
      batch = { repo, skills: [], extraArgs: ADD_EXTRA_ARGS[repo] ?? [] };
      byRepo.set(repo, batch);
      addBatches.push(batch);
    }
    batch.skills.push(name);
  }

  return { removals, preservedInstalled, skipStaleRemoval, addBatches };
}

/** The `skills remove` argv for one stale name (stale removal narrowed to non-Hermes). */
export function removalToSkillsArgs(name: string, nonHermesAgents: string[]): string[] {
  return ["remove", "-g", name, "-a", ...nonHermesAgents, "-y"];
}

/** The `skills add` argv for one missing-repo batch (extra flags after -y, like bash). */
export function addBatchToSkillsArgs(batch: SyncAddBatch, agents: string[]): string[] {
  return ["add", batch.repo, "-g", "-a", ...agents, "-s", ...batch.skills, "-y", ...batch.extraArgs];
}

// ── broken-symlink sweeps ─────────────────────────────────────────────────────

/** True when the depth-1 entry is a symlink whose target no longer resolves. */
function isDanglingSymlink(fullPath: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(fullPath);
  } catch {
    return false;
  }
  return st.isSymbolicLink() && !fs.existsSync(fullPath);
}

/**
 * The owned-dir cleanup: remove every dangling symlink at depth 1 of `dir`
 * (~/.agents/skills and ~/.claude/skills are always ours). Returns removed
 * basenames, sorted. Missing dir is a no-op.
 */
export function sweepBrokenSymlinks(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries.sort()) {
    const full = path.join(dir, name);
    if (!isDanglingSymlink(full)) continue;
    fs.rmSync(full, { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * The Hermes append-only sweep: remove ONLY dangling symlinks whose raw readlink
 * target starts with one of our own prefixes (the repo's skills/ dir, the absolute
 * ~/.agents/skills/ form, or the relative ../../.agents/skills/ form the skills
 * CLI emits). Real directories, live symlinks, and foreign-target danglers are
 * never touched — Hermes manages its own collection.
 */
export function sweepHermesBrokenSymlinks(hermesDir: string, ownPrefixes: string[]): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(hermesDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries.sort()) {
    const full = path.join(hermesDir, name);
    if (!isDanglingSymlink(full)) continue;
    let dest: string;
    try {
      dest = fs.readlinkSync(full);
    } catch {
      continue;
    }
    if (!ownPrefixes.some((p) => dest.startsWith(p))) continue;
    fs.rmSync(full, { force: true });
    removed.push(name);
  }
  return removed;
}

// ── resolved summary (print_resolved_repo_skill_summary) ────────────────────

export interface RepoSummary {
  repo: string;
  /** Sorted-unique declared skill names. */
  skills: string[];
  /** Declared names equal the repo's full upstream enumeration (`^` marker). */
  fullCoverage: boolean;
}

/**
 * build_resolved_repo_skill_summary_data over fully explicit specs: repos sorted,
 * skills sorted-unique, and the full-coverage marker computed by enumerating each
 * repo's upstream names (an enumeration failure aborts the sync, as in bash —
 * the summary resolves before any mutation so failures happen first).
 */
export function buildRepoSkillSummary(specs: string[], enumerate: UpstreamEnumerator): RepoSummary[] {
  const byRepo = new Map<string, Set<string>>();
  for (const spec of specs) {
    const repo = specRepo(spec);
    const name = specSkill(spec);
    if (!name) continue;
    let set = byRepo.get(repo);
    if (!set) {
      set = new Set();
      byRepo.set(repo, set);
    }
    set.add(name);
  }
  const out: RepoSummary[] = [];
  for (const repo of [...byRepo.keys()].sort()) {
    const skills = [...byRepo.get(repo)!].sort();
    const upstream = [...new Set(enumerate(repo))].sort();
    const fullCoverage = skills.length === upstream.length && skills.every((s, i) => s === upstream[i]);
    out.push({ repo, skills, fullCoverage });
  }
  return out;
}
