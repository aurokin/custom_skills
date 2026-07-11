// Bridge from desired state to concrete, absolute placements. Runs the read-graph
// solver per skill and expands the solver's tilde-form paths against the injected
// env. Shared by plan, status, doctor, and explain so they all agree on where a
// skill lands.

import { type SkmEnv, expandTilde } from "./env";
import { solvePlacements } from "./solver";
import type {
  BleedEntry,
  DesiredSkill,
  DesiredState,
  Dialect,
  MachineConfig,
  Placement,
  Registry,
  SkillSource,
  UnreachableEntry,
} from "./types";

/** One solved placement with its source and owning skill, path already absolute. */
export interface DesiredPlacement {
  skill: string;
  source: SkillSource;
  desiredSkill: DesiredSkill;
  placement: Placement;
}

export interface SolvedDesired {
  placements: DesiredPlacement[];
  unreachable: UnreachableEntry[];
  bleed: BleedEntry[];
}

/** First-party dir id → rendering dialect (only these dirs ever render). */
const DIR_DIALECT: Record<string, Dialect> = {
  claude: "claude",
  copilot: "copilot",
  codex: "codex",
};

export function dialectForDir(dir: string): Dialect | undefined {
  return DIR_DIALECT[dir];
}

/** Solve every desired skill into absolute placements plus unreachable/bleed reports. */
export function computeDesiredPlacements(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
): SolvedDesired {
  const placements: DesiredPlacement[] = [];
  const unreachable: UnreachableEntry[] = [];
  const bleed: BleedEntry[] = [];

  for (const skill of desired.skills) {
    const solved = solvePlacements(skill, config, registry);
    for (const p of solved.placements) {
      const abs = expandTilde(env, p.path);
      placements.push({
        skill: skill.name,
        source: skill.source,
        desiredSkill: skill,
        placement: { ...p, path: abs },
      });
      if (p.bleed && p.bleed.length > 0) {
        bleed.push({ skill: skill.name, path: abs, agent: p.agent, readers: p.bleed });
      }
    }
    for (const agent of solved.unreachable) {
      unreachable.push({ skill: skill.name, agent });
    }
  }

  return { placements, unreachable, bleed };
}
