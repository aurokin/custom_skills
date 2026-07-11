// `skm doctor` — health checks over the live registry, config, desired state and
// disk: broken owned symlinks, rendered-hash drift, deny-guarantee verification,
// private-content leaks, missing roots, and kill-switch suggestions. --fix repairs
// only owned artifacts. Owned by the doctor team.

import * as fs from "node:fs";
import * as path from "node:path";
import { loadContext, registryPath } from "./context";
import { type SkmEnv, expandTilde } from "./env";
import { loadMachineConfig } from "./machine-config";
import { computeDesiredPlacements, dialectForDir } from "./placements";
import { privacyViolation } from "./privacy";
import { dirPath, loadRegistry, readersOf } from "./registry";
import { renderSkill } from "./render";
import { resolveDesiredState } from "./resolve";
import { loadState, saveState, upsertPlacement } from "./state";
import { scanEntry, scanRegistryDirs } from "./scan";
import type {
  DesiredSkill,
  DesiredState,
  ExitCodeValue,
  Finding,
  MachineConfig,
  Registry,
  StateFile,
  VerbOptions,
  VerbOutcome,
} from "./types";
import { ExitCode } from "./types";

/** Verb entry: exit 2 when actionable (error/warn) findings exist. */
export async function runDoctor(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const registry = loadRegistry(registryPath());
  const config = loadMachineConfig(env, registry);

  // Missing roots are reported (not aborted) so doctor can still diagnose the rest.
  const missing: Finding[] = [];
  const present = config.roots.filter((r) => {
    if (fs.existsSync(r.path)) return true;
    missing.push({
      category: "reconcile",
      severity: "error",
      message: `registered root '${r.name}' missing on disk: ${r.path}`,
      fixable: false,
    });
    return false;
  });
  const desired = resolveDesiredState(env, { ...config, roots: present }, registry);
  const state = loadState(env);

  let findings = [...missing, ...diagnose(env, config, registry, desired, state)];

  if (opts.fix) {
    const fixed = applyFixes(env, config, registry, desired, state);
    if (fixed > 0) {
      saveState(env, state);
      // Re-diagnose to reflect repairs.
      findings = [...missing, ...diagnose(env, config, registry, desired, state)];
      findings.push({ category: "reconcile", severity: "info", message: `applied ${fixed} fix(es)`, fixable: false });
    }
  }

  const actionable = findings.some((f) => f.severity !== "info");
  const exitCode: ExitCodeValue = actionable ? ExitCode.PENDING : ExitCode.CLEAN;
  return { exitCode, json: { findings }, human: renderHuman(findings) };
}

/** Collect findings across the live registry, config, desired state, and disk. */
export function diagnose(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): Finding[] {
  const findings: Finding[] = [];

  // 1. Broken owned symlinks + 2. rendered-hash drift.
  for (const [skill, artifact] of Object.entries(state.artifacts)) {
    for (const sp of artifact.placements) {
      const entry = scanEntry(env, expandTilde(env, sp.path));
      if (sp.kind === "symlink") {
        if (entry.kind === "symlink" && entry.broken) {
          findings.push({ category: "broken-link", severity: "error", skill, path: sp.path, message: `broken owned symlink -> ${entry.linkTarget ?? "?"}`, fixable: true });
        } else if (entry.kind === "absent") {
          findings.push({ category: "broken-link", severity: "error", skill, path: sp.path, message: "owned symlink missing", fixable: true });
        }
      } else if (sp.kind === "rendered" && entry.kind === "dir" && entry.sha256OfSkillMd !== sp.hash) {
        findings.push({ category: "reconcile", severity: "warn", skill, path: sp.path, message: "rendered artifact hand-edited (hash mismatch)", fixable: true });
      }
    }
  }

  // 3. Deny-guarantee verification against the live registry.
  findings.push(...verifyDenyGuarantee(env, config, registry, desired, state));

  // 4a. Private-content leaks: owned private placements in disallowed worktrees.
  for (const [skill, artifact] of Object.entries(state.artifacts)) {
    if (artifact.source.visibility !== "private") continue;
    for (const sp of artifact.placements) {
      const reason = privacyViolation(config, expandTilde(env, sp.path));
      if (reason) findings.push({ category: "private-leak", severity: "error", skill, path: sp.path, message: reason, fixable: false });
    }
  }

  // 4b. Private content in UNEXPECTED locations (design §9): scan agent dirs for
  // entries skm does not own whose SKILL.md matches a private source's hash, or
  // symlinks resolving into a private root. Catches stale layouts, manual copies,
  // and the --plan-then-drop-from-state case.
  findings.push(...scanUnmanagedPrivateLeaks(env, config, registry, desired, state));

  // 5. Kill-switch suggestions for bleed onto agents with a suppression env var.
  findings.push(...killSwitchSuggestions(env, config, registry, desired));

  return findings;
}

/** For each deny-scoped skill, ensure no owned placement sits in a denied agent's read set. */
function verifyDenyGuarantee(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): Finding[] {
  const findings: Finding[] = [];
  const dirByPath = registryDirByPath(env, registry);

  for (const skill of desired.skills) {
    const scope = skill.scoping;
    // Only `deny` is a HARD guarantee (design §5). `allow` is best-effort: the
    // non-allowed agents are soft bleed ("reported, not blocked"), so an
    // allow-scoped skill correctly placed in a bled-onto dir must NOT be flagged
    // as a deny-guarantee violation (deny-solver-1).
    if (!scope?.deny) continue;
    const denied = scope.deny.filter((a) => registry.agents[a] !== undefined);
    const deniedSet = new Set(denied);
    if (deniedSet.size === 0) continue;

    const artifact = state.artifacts[skill.name];
    if (!artifact) continue;
    for (const sp of artifact.placements) {
      const parent = path.resolve(path.dirname(expandTilde(env, sp.path)));
      const dirId = dirByPath.get(parent);
      if (!dirId) continue;
      const readers = readersOf(registry, dirId, { includeMaybe: true });
      const violators = readers.filter((r) => deniedSet.has(r));
      if (violators.length > 0) {
        findings.push({
          category: "deny-violation",
          severity: "error",
          skill: skill.name,
          path: sp.path,
          message: `denied agent(s) ${violators.join(", ")} read dir '${dirId}' where '${skill.name}' is placed`,
          fixable: false,
        });
      }
    }
  }
  return findings;
}

/**
 * Scan every registry dir for content skm does not own that is (a) a copy whose
 * SKILL.md hashes to a private source's SKILL.md, or (b) a symlink resolving into a
 * private root. Either is private material sitting somewhere skm did not sanction.
 */
function scanUnmanagedPrivateLeaks(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): Finding[] {
  const privateSourceHash = new Map<string, string>(); // hash → skill name
  for (const skill of desired.skills) {
    if (skill.source.visibility !== "private") continue;
    const hash = scanEntry(env, skill.source.path).sha256OfSkillMd;
    if (hash) privateSourceHash.set(hash, skill.name);
  }
  const privateRoots = config.roots
    .filter((r) => r.visibility === "private")
    .map((r) => path.resolve(expandTilde(env, r.path)));

  if (privateSourceHash.size === 0 && privateRoots.length === 0) return [];

  const owned = new Set<string>();
  for (const artifact of Object.values(state.artifacts)) {
    for (const sp of artifact.placements) owned.add(path.resolve(expandTilde(env, sp.path)));
  }

  const findings: Finding[] = [];
  for (const entries of Object.values(scanRegistryDirs(env, registry))) {
    for (const entry of entries) {
      if (owned.has(path.resolve(entry.path))) continue; // owned placements handled above

      const matchedSkill = entry.sha256OfSkillMd
        ? privateSourceHash.get(entry.sha256OfSkillMd)
        : undefined;
      if (matchedSkill) {
        findings.push({
          category: "private-leak",
          severity: "error",
          skill: matchedSkill,
          path: entry.path,
          message: `unmanaged copy of private skill '${matchedSkill}' found in an agent dir`,
          fixable: false,
        });
        continue;
      }

      if (
        entry.kind === "symlink" &&
        entry.resolvedTarget &&
        privateRoots.some((root) => isInside(entry.resolvedTarget!, root))
      ) {
        findings.push({
          category: "private-leak",
          severity: "error",
          path: entry.path,
          message: `unmanaged symlink resolves into a private root -> ${entry.resolvedTarget}`,
          fixable: false,
        });
      }
    }
  }
  return findings;
}

/** True when `child` is `parent` or nested under it (path-segment aware). */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Suggest an agent's kill switch when a scoped skill bleeds onto it. */
function killSwitchSuggestions(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
): Finding[] {
  const findings: Finding[] = [];
  const { bleed } = computeDesiredPlacements(env, config, registry, desired);
  const seen = new Set<string>();
  for (const b of bleed) {
    for (const reader of b.readers) {
      const agent = registry.agents[reader];
      if (!agent?.killSwitches?.length) continue;
      const sw = agent.killSwitches[0]!;
      const key = `${b.skill}:${reader}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        category: "env-suggestion",
        severity: "info",
        skill: b.skill,
        message: `set ${sw}=1 to hide '${b.skill}' from ${reader} (incidental reader of ${b.path})`,
        fixable: false,
      });
    }
  }
  return findings;
}

// ── --fix ────────────────────────────────────────────────────────────────────

/** Re-link broken owned symlinks and re-render hand-edited rendered artifacts. */
function applyFixes(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): number {
  const byPath = new Map(
    computeDesiredPlacements(env, config, registry, desired).placements.map((dp) => [
      path.resolve(dp.placement.path),
      dp,
    ]),
  );

  let fixed = 0;
  for (const [skill, artifact] of Object.entries(state.artifacts)) {
    for (const sp of artifact.placements) {
      const abs = path.resolve(expandTilde(env, sp.path));
      const dp = byPath.get(abs);
      if (!dp) continue; // only repair owned + still-desired placements

      // Never re-materialize private content into a worktree that has become
      // non-allowlisted since the artifact was first placed (privacy-doctor-fix-
      // bypasses-guard). diagnose already reported it as a private-leak.
      if (artifact.source.visibility === "private" && privacyViolation(config, abs)) continue;

      const entry = scanEntry(env, abs);

      if (sp.kind === "symlink" && (entry.kind === "absent" || (entry.kind === "symlink" && entry.broken))) {
        removeExisting(abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.symlinkSync(dp.source.path, abs);
        fixed++;
      } else if (sp.kind === "rendered" && entry.kind === "dir" && entry.sha256OfSkillMd !== sp.hash) {
        const dialect = dialectForDir(dp.placement.dir);
        if (!dialect) continue;
        removeExisting(abs);
        const skillDef: DesiredSkill = { name: skill, source: dp.source, overrides: dp.desiredSkill.overrides };
        const res = renderSkill(env, skillDef, dialect, abs);
        upsertPlacement(state, skill, artifact.source, { agent: sp.agent, path: abs, kind: "rendered", hash: res.hash });
        fixed++;
      }
    }
  }
  return fixed;
}

function removeExisting(abs: string): void {
  try {
    const stat = fs.lstatSync(abs);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(abs, { recursive: true, force: true });
    else fs.unlinkSync(abs);
  } catch {
    /* absent */
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Map each registry directory's absolute path → its dir id (for reverse lookup). */
function registryDirByPath(env: SkmEnv, registry: Registry): Map<string, string> {
  const out = new Map<string, string>();
  for (const dirId of Object.keys(registry.directories)) {
    out.set(path.resolve(dirPath(env, registry, dirId)), dirId);
  }
  return out;
}

function renderHuman(findings: Finding[]): string {
  if (findings.length === 0) return "doctor: healthy.";
  const glyph: Record<string, string> = { error: "×", warn: "!", info: "·" };
  return findings.map((f) => `  ${glyph[f.severity] ?? "?"} ${f.category}: ${f.message}${f.path ? `  (${f.path})` : ""}`).join("\n");
}
