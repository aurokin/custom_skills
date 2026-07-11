// Resolver: composes every registered root into one desired state (union of
// skills/<name>/ dirs containing SKILL.md), applies scoping, detects name
// collisions (later root wins), and hashes the result. Owned by the resolve team.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadScopingSource, publicScopingPath, scopingForSkill } from "./catalog";
import type { SkmEnv } from "./env";
import { loadOverlay } from "./overlay";
import type {
  AgentOverrides,
  AgentScope,
  DesiredSkill,
  DesiredState,
  MachineConfig,
  Registry,
  Root,
  ScopingSource,
  Warning,
} from "./types";

/**
 * A registered root is absent on disk. Hard abort — never interpret a missing
 * root as "delete its skills" (design §7, ADR 0006). Defined here pending a hoist
 * into errors.ts by the integrator.
 */
export class RootMissingError extends Error {
  constructor(root: Root) {
    super(`registered root '${root.name}' missing on disk: ${root.path}`);
    this.name = "RootMissingError";
  }
}

/** agents/<dialect>.yaml override files the resolver advertises per skill. */
const OVERRIDE_DIALECTS = ["claude", "copilot", "codex", "openai"] as const;

/** Build the desired state from config roots + registry + scoping sources. */
export function resolveDesiredState(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
): DesiredState {
  const warnings: Warning[] = [];
  const byName = new Map<string, DesiredSkill>();
  const ownerRoot = new Map<string, string>();

  for (const root of config.roots) {
    if (!fs.existsSync(root.path)) throw new RootMissingError(root);
    const scoping = scopingForRoot(root, registry);

    const skillsDir = path.join(root.path, "skills");
    if (!fs.existsSync(skillsDir)) continue;

    const names = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const name of names) {
      const skillDir = path.join(skillsDir, name);
      const skillMd = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue; // a dir without SKILL.md is not a skill

      checkFrontmatter(skillMd, name, warnings);

      const desired: DesiredSkill = {
        name,
        source: { root: root.name, visibility: root.visibility, path: skillDir },
        overrides: detectOverrides(skillDir),
      };
      const scope = scopingForSkill(scoping, name);
      if (scope) desired.scoping = scope;

      if (byName.has(name)) {
        warnings.push({
          kind: "collision",
          skill: name,
          message: `skill '${name}' defined in roots '${ownerRoot.get(name)}' and '${root.name}'; '${root.name}' wins`,
        });
      }
      byName.set(name, desired);
      ownerRoot.set(name, root.name);
    }
  }

  const skills = [...byName.values()].sort(byNameAsc);
  return { skills, warnings, hash: hashDesiredState(skills) };
}

/** Stable content hash of the desired skill set (apply --plan precondition). */
export function hashDesiredState(skills: DesiredSkill[]): string {
  const canonical = [...skills].sort(byNameAsc).map((s) => ({
    name: s.name,
    root: s.source.root,
    visibility: s.source.visibility,
    path: s.source.path,
    scoping: normalizeScopeForHash(s.scoping),
    overrides: Object.keys(s.overrides).sort(),
  }));
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

// ── internals ────────────────────────────────────────────────────────────────

/** Public-visibility roots scope via catalog/agent-scopes.json; others via overlay.json. */
function scopingForRoot(root: Root, reg: Registry): ScopingSource | undefined {
  if (root.visibility === "public") {
    const p = publicScopingPath(root.path);
    return fs.existsSync(p) ? loadScopingSource(p, reg) : undefined;
  }
  return loadOverlay(root, reg);
}

function detectOverrides(skillDir: string): AgentOverrides {
  const agentsDir = path.join(skillDir, "agents");
  const out: AgentOverrides = {};
  for (const dialect of OVERRIDE_DIALECTS) {
    const f = path.join(agentsDir, `${dialect}.yaml`);
    if (fs.existsSync(f)) out[dialect] = f;
  }
  return out;
}

function checkFrontmatter(skillMd: string, name: string, warnings: Warning[]): void {
  const fm = parseFrontmatter(fs.readFileSync(skillMd, "utf8"));
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) {
    warnings.push(frontmatterWarn(name, "SKILL.md has no readable YAML frontmatter"));
    return;
  }
  const o = fm as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) {
    warnings.push(frontmatterWarn(name, "frontmatter missing 'name'"));
  }
  if (typeof o.description !== "string" || o.description.length === 0) {
    warnings.push(frontmatterWarn(name, "frontmatter missing 'description'"));
  }
}

function parseFrontmatter(content: string): unknown {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return undefined;
  try {
    return parseYaml(m[1] ?? "");
  } catch {
    return undefined;
  }
}

function frontmatterWarn(skill: string, message: string): Warning {
  return { kind: "frontmatter", skill, message };
}

function normalizeScopeForHash(scope?: AgentScope): unknown {
  if (!scope) return null;
  if (scope.allow) return { allow: [...scope.allow].sort() };
  return { deny: [...(scope.deny ?? [])].sort() };
}

function byNameAsc(a: DesiredSkill, b: DesiredSkill): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
