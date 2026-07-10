// `skm explain <skill>` — source root, scoping, computed placements, bleed, and
// visibility for one skill. Owned by the explain team.

import { loadContext } from "./context";
import { UsageError } from "./errors";
import { type SkmEnv, expandTilde } from "./env";
import { solvePlacements } from "./solver";
import type {
  DesiredState,
  MachineConfig,
  Placement,
  Registry,
  SkillExplanation,
  StateFile,
  VerbOptions,
  VerbOutcome,
} from "./types";
import { ExitCode } from "./types";

/** Verb entry. Requires one positional skill name. */
export async function runExplain(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const name = opts.args[0];
  if (!name) throw new UsageError("explain requires a skill name: skm explain <skill>");
  const ctx = loadContext(env);
  const explanation = explainSkill(env, ctx.config, ctx.registry, ctx.desired, ctx.state, name);
  return { exitCode: ExitCode.CLEAN, json: explanation, human: renderHuman(explanation) };
}

/** Build the explanation record for a single skill. */
export function explainSkill(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  _state: StateFile,
  name: string,
): SkillExplanation {
  const skill = desired.skills.find((s) => s.name === name);
  if (!skill) throw new UsageError(`unknown skill: ${name}`);

  const solved = solvePlacements(skill, config, registry);
  const placements: Placement[] = solved.placements.map((p) => ({ ...p, path: expandTilde(env, p.path) }));

  const bleed: Record<string, string[]> = {};
  for (const p of placements) {
    if (p.bleed && p.bleed.length > 0) bleed[p.path] = p.bleed;
  }

  const explanation: SkillExplanation = {
    name: skill.name,
    source: skill.source,
    placements,
    unreachable: solved.unreachable,
    bleed,
  };
  if (skill.scoping) explanation.scoping = skill.scoping;
  return explanation;
}

function renderHuman(e: SkillExplanation): string {
  const lines: string[] = [];
  lines.push(`${e.name}  (${e.source.visibility}, root '${e.source.root}')`);
  lines.push(`  source: ${e.source.path}`);
  if (e.scoping?.allow) lines.push(`  scoping: allow ${e.scoping.allow.join(", ")}`);
  else if (e.scoping?.deny) lines.push(`  scoping: deny ${e.scoping.deny.join(", ")}`);
  else lines.push("  scoping: unscoped (shared)");
  lines.push("  placements:");
  for (const p of e.placements) {
    const bleed = e.bleed[p.path]?.length ? `  bleed→ ${e.bleed[p.path]!.join(", ")}` : "";
    lines.push(`    ${p.agent.padEnd(16)} ${p.kind.padEnd(8)} ${p.path}${bleed}`);
  }
  if (e.unreachable.length) lines.push(`  unreachable: ${e.unreachable.join(", ")}`);
  return lines.join("\n");
}
