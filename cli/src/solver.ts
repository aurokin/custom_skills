// Read-graph solver: turns one skill's scoping into concrete placements.
// - unscoped → shared dir + claude dir (+ hermes when enabled, add-only)
// - deny → hard guarantee: no dir any denied agent reads OR maybeReads
// - allow → exactly-these; each allowed agent gets a dir no denied agent reads,
//   preferring its ownDir; otherwise the agent is reported unreachable
// Incidental readers (bleed) are recorded per placement. Owned by the placement team.

import * as path from "node:path";
import { enabledAgents, readersOf } from "./registry";
import type {
  DesiredSkill,
  MachineConfig,
  Placement,
  Registry,
  SolvedPlacement,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Local type extensions (noted to the integrator for possible hoist into
// types.ts). Both are optional and structurally widen Placement / SolvedPlacement,
// so a SolveResult is assignable everywhere a SolvedPlacement is expected.
// ─────────────────────────────────────────────────────────────────────────────

export interface SolvedPlacementLocal extends Placement {
  /** Chosen dir is registry-flagged deprecated (codex dir); plan surfaces a warning. */
  deprecated?: boolean;
  /** Placement targets an add-only agent dir (hermes): apply never prunes/overwrites it. */
  addOnly?: boolean;
}

export interface SolveResult extends SolvedPlacement {
  placements: SolvedPlacementLocal[];
}

/** Solve placements for one skill against the enabled agents and read graph. */
export function solvePlacements(
  skill: DesiredSkill,
  config: MachineConfig,
  registry: Registry,
): SolveResult {
  const scope = skill.scoping;
  const enabled = enabledAgents(config, registry);

  const allowMode = scope?.allow !== undefined;
  const denyMode = scope?.deny !== undefined;

  if (!allowMode && !denyMode) {
    return solveUnscoped(skill, registry, enabled);
  }

  // Determine the agents that get placements and the agents whose read-dirs are
  // a HARD constraint. Note the asymmetry (design §5):
  //   allow → place exactly the listed agents; "deny everyone else" is soft (bleed).
  //   deny  → place all enabled-except-denied; denied dirs are a hard guarantee.
  let allowedAgents: string[];
  let hardDenied: string[];
  if (allowMode) {
    allowedAgents = [...(scope!.allow ?? [])];
    hardDenied = [];
  } else {
    const deny = scope!.deny ?? [];
    hardDenied = deny.filter((a) => registry.agents[a] !== undefined);
    allowedAgents = enabled.filter((a) => !deny.includes(a));
  }

  // Dirs any denied agent reads OR maybeReads are forbidden (the hard guarantee).
  // Scoped skills are additionally never placed in the shared dir (ADR 0003).
  const forbiddenDirs = new Set<string>(["shared"]);
  for (const id of hardDenied) {
    const agent = registry.agents[id];
    if (!agent) continue;
    for (const dir of agent.reads) forbiddenDirs.add(dir);
    for (const dir of agent.maybeReads) forbiddenDirs.add(dir);
  }

  // Resolve each allowed agent to a usable dir (prefer ownDir), else unreachable.
  const chosen: { agent: string; dir: string }[] = [];
  const unreachable: string[] = [];
  for (const agentId of allowedAgents) {
    const agent = registry.agents[agentId];
    if (!agent || agent.skillsSupport !== "supported") {
      unreachable.push(agentId);
      continue;
    }
    const dir = candidateDirs(agent).find((d) => !forbiddenDirs.has(d));
    if (dir === undefined) {
      unreachable.push(agentId);
      continue;
    }
    chosen.push({ agent: agentId, dir });
  }

  // Group agents that landed on the same dir into a single placement.
  const byDir = new Map<string, string[]>();
  for (const { agent, dir } of chosen) {
    const arr = byDir.get(dir);
    if (arr) arr.push(agent);
    else byDir.set(dir, [agent]);
  }

  // An agent that received its OWN placement is an intended recipient of the skill,
  // so it must never be reported as incidental bleed on another placement's dir
  // (nor become a kill-switch suggestion). Exclude the full placed set from bleed.
  const placedAgents = chosen.map((c) => c.agent);

  const placements: SolvedPlacementLocal[] = [];
  for (const [dir, agents] of byDir) {
    const rep = agents.find((a) => registry.agents[a]?.ownDir === dir) ?? agents[0]!;
    placements.push(makePlacement(registry, skill, rep, dir, placedAgents));
  }

  return { skill: skill.name, placements, unreachable };
}

/** Incidental readers of a placement's dir beyond the intended agent(s). */
export function bleedFor(
  registry: Registry,
  placement: Placement,
  intended: string[],
): string[] {
  const intendedSet = new Set(intended);
  // Hard reads only: a maybe-reader (e.g. grok on the claude dir) is a deny-guarantee
  // concern, not incidental visibility, so it is excluded from bleed reporting.
  return readersOf(registry, placement.dir)
    .filter((r) => !intendedSet.has(r))
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Dirs an agent reads that are eligible for scoped placement (ownDir first, no shared). */
function candidateDirs(agent: Registry["agents"][string]): string[] {
  const reads = agent.reads.filter((d) => d !== "shared");
  if (agent.ownDir && agent.ownDir !== "shared") {
    return [agent.ownDir, ...reads.filter((d) => d !== agent.ownDir)];
  }
  return reads;
}

function makePlacement(
  registry: Registry,
  skill: DesiredSkill,
  agent: string,
  dir: string,
  intended: string[],
): SolvedPlacementLocal {
  const targetPath = path.join(registry.directories[dir]!.path, skill.name);
  const kind = renderKind(skill, dir);
  const placement: SolvedPlacementLocal = {
    agent,
    dir,
    path: targetPath,
    kind,
    bleed: bleedFor(registry, { agent, dir, path: targetPath, kind }, intended),
  };
  if (registry.directories[dir]?.deprecated) placement.deprecated = true;
  if (registry.agents[agent]?.addOnly) placement.addOnly = true;
  return placement;
}

/** rendered iff the chosen first-party dir has a matching agents/<dialect>.yaml override. */
function renderKind(skill: DesiredSkill, dir: string): Placement["kind"] {
  if (dir === "claude" && skill.overrides.claude) return "rendered";
  if (dir === "copilot" && skill.overrides.copilot) return "rendered";
  if (dir === "codex" && skill.overrides.codex) return "rendered";
  return "symlink";
}

/** Unscoped: shared covers the shared-readers; claude and hermes need their own dirs. */
function solveUnscoped(
  skill: DesiredSkill,
  registry: Registry,
  enabled: string[],
): SolveResult {
  const name = skill.name;
  const placements: SolvedPlacementLocal[] = [
    {
      agent: "shared",
      dir: "shared",
      path: path.join(registry.directories.shared!.path, name),
      kind: "symlink",
    },
    {
      agent: "claude-code",
      dir: "claude",
      path: path.join(registry.directories.claude!.path, name),
      kind: skill.overrides.claude ? "rendered" : "symlink",
    },
  ];
  if (enabled.includes("hermes")) {
    placements.push({
      agent: "hermes",
      dir: "hermes",
      path: path.join(registry.directories.hermes!.path, name),
      kind: "symlink",
      addOnly: true,
    });
  }
  return { skill: name, placements, unreachable: [] };
}
