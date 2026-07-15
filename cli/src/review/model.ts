// The review model (ADR 0013): a versioned JSON document assembled entirely
// from engine APIs. The HTML page is a pure renderer of this model — every
// fact it shows must exist here; the template computes presentation only.

import * as fs from "node:fs";
import * as path from "node:path";
import { loadCatalogSpecs } from "../catalog-specs";
import type { SkmContext } from "../context";
import { type SkmEnv, expandTilde } from "../env";
import { computeDesiredPlacements } from "../placements";
import { renderComposedSkill } from "../composed/render";
import { computeDrift } from "../status";
import type { DesiredPlacement, DriftClass, Posture } from "../types";

export interface ReviewFile {
  path: string;
  content: string;
}

export interface ReviewVariant {
  key: string;
  label: string;
  root: string;
  files: ReviewFile[];
  /** Drift-join result for this variant's placement, when one exists. */
  deployed?: ReviewDeployed;
}

export interface ReviewDeployed {
  path: string;
  /** "clean" = placement desired, present, no drift finding. */
  status: "clean" | DriftClass;
  detail?: string;
}

export interface ReviewMatrixCell {
  files: ReviewFile[];
}

export interface ReviewMatrix {
  consumers: { key: string; deployed?: ReviewDeployed }[];
  postures: Posture[];
  sourcePosture: Posture;
  /** Rendered cells keyed `<consumer>|<posture>`. */
  cells: Record<string, ReviewMatrixCell>;
}

export interface ReviewUnit {
  id: string;
  group: string;
  name: string;
  badges: string[];
  note?: string;
  variants: ReviewVariant[];
  matrix?: ReviewMatrix;
}

export interface ReviewInvEntry {
  name: string;
  kind: string;
  label: string;
  doc?: string;
  drift?: ReviewDeployed;
}

export interface ReviewInvDir {
  id: string;
  path: string;
  entries: ReviewInvEntry[];
}

export interface ReviewModel {
  reviewModelVersion: 1;
  built: string;
  machine: string;
  units: ReviewUnit[];
  inventory: ReviewInvDir[];
  docs: Record<string, { skill: string; files: string[] }>;
}

const DOC_CAP = 80_000;
const DOC_FILE_LIST_CAP = 60;

function listTree(root: string): ReviewFile[] {
  const out: ReviewFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else out.push({ path: r, content: fs.readFileSync(abs, "utf8") });
    }
  };
  walk(root, "");
  out.sort((a, b) => {
    const w = (p: string) => (p === "SKILL.md" || p === "SKILL.tmpl.md" || p === "agent.yaml" ? 0 : p === "instructions.md" ? 1 : 2);
    return w(a.path) - w(b.path) || a.path.localeCompare(b.path);
  });
  return out;
}

function tilde(env: SkmEnv, p: string): string {
  return p.startsWith(env.home) ? `~${p.slice(env.home.length)}` : p;
}

/** Join a placement against the drift findings: absence of a finding = clean. */
function joinDrift(
  driftByPath: Map<string, { drift: DriftClass; detail: string }>,
  env: SkmEnv,
  placementPath: string,
): ReviewDeployed {
  const finding = driftByPath.get(path.resolve(placementPath));
  return finding
    ? { path: tilde(env, placementPath), status: finding.drift, detail: finding.detail }
    : { path: tilde(env, placementPath), status: "clean" };
}

export function buildReviewModel(env: SkmEnv, ctx: SkmContext): ReviewModel {
  const { config, registry, desired, state } = ctx;
  const solved = computeDesiredPlacements(env, config, registry, desired);
  const findings = computeDrift(env, config, registry, desired, state);
  const driftByPath = new Map(findings.map((f) => [path.resolve(f.path), { drift: f.drift, detail: f.detail }]));
  const placementsBySkill = new Map<string, DesiredPlacement[]>();
  for (const dp of solved.placements) {
    const key = dp.skill;
    if (!placementsBySkill.has(key)) placementsBySkill.set(key, []);
    placementsBySkill.get(key)!.push(dp);
  }

  const rootByName = new Map(config.roots.map((r) => [r.name, r]));
  const units: ReviewUnit[] = [];
  const docs: ReviewModel["docs"] = {};

  const registerDoc = (skillDir: string): string | undefined => {
    try {
      const real = fs.realpathSync(skillDir);
      const skillMd = path.join(real, "SKILL.md");
      if (!fs.existsSync(skillMd)) return undefined;
      const key = tilde(env, real);
      if (!docs[key]) {
        let text = fs.readFileSync(skillMd, "utf8");
        if (text.length > DOC_CAP) text = `${text.slice(0, DOC_CAP)}\n… [truncated]`;
        const files: string[] = [];
        const walk = (dir: string, base: string) => {
          for (const f of fs.readdirSync(dir).sort()) {
            if (f.startsWith(".")) continue;
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) walk(p, `${base}${f}/`);
            else if (`${base}${f}` !== "SKILL.md") files.push(`${base}${f}`);
            if (files.length > DOC_FILE_LIST_CAP) {
              files.push("…");
              return;
            }
          }
        };
        walk(real, "");
        docs[key] = { skill: text, files };
      }
      return key;
    } catch {
      return undefined;
    }
  };

  // ── Native skills (public + overlay roots), gated variants included ──
  for (const skill of desired.skills) {
    const root = rootByName.get(skill.source.root);
    const visibility = root?.visibility ?? "public";
    const group = visibility === "private" ? "Private skills" : "Public skills";
    const badges = [visibility, skill.gated ? "gated" : "symlinked"];
    if (skill.source.note) badges.push("noted");
    const variants: ReviewVariant[] = [
      { key: "source", label: "Source", root: tilde(env, skill.source.path), files: listTree(skill.source.path) },
    ];
    for (const dp of placementsBySkill.get(skill.name) ?? []) {
      const p = dp.placement;
      const deployed = joinDrift(driftByPath, env, p.path);
      if (skill.gated && p.kind !== "symlink" && fs.existsSync(p.path)) {
        variants.push({
          key: String(p.agent),
          label: String(p.agent),
          root: tilde(env, p.path),
          files: listTree(p.path),
          deployed,
        });
      } else if (variants[0] && !variants[0].deployed) {
        variants[0].deployed = deployed;
      }
    }
    units.push({
      id: `${visibility}-${skill.name}`,
      group,
      name: skill.name,
      badges,
      note: skill.source.note,
      variants,
    });
  }

  // ── Composed skills: full consumer × posture matrix via the real renderer ──
  for (const skill of desired.composedSkills) {
    const consumers = Object.keys(skill.consumers).sort();
    const postures: Posture[] = ["sandboxed", "yolo"];
    const cells: Record<string, ReviewMatrixCell> = {};
    for (const consumer of consumers) {
      for (const posture of postures) {
        const rendered = renderComposedSkill({ ...skill, posture }, consumer, registry);
        cells[`${consumer}|${posture}`] = {
          files: Object.entries(rendered)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([p, content]) => ({ path: p, content })),
        };
      }
    }
    const matrixConsumers = consumers.map((c) => {
      const dp = (placementsBySkill.get(skill.name) ?? []).find((p) => String(p.placement.agent) === c);
      return dp ? { key: c, deployed: joinDrift(driftByPath, env, dp.placement.path) } : { key: c };
    });
    units.push({
      id: `composed-${skill.name}`,
      group: "Composed skills",
      name: skill.name,
      badges: ["composed", skill.posture],
      variants: [
        { key: "source", label: "Source", root: tilde(env, skill.source.path), files: listTree(skill.source.path) },
      ],
      matrix: { consumers: matrixConsumers, postures, sourcePosture: skill.posture, cells },
    });
  }

  // ── Agent definitions: source + every rendered placement ──
  for (const def of desired.agentDefs) {
    const variants: ReviewVariant[] = [
      { key: "source", label: "Source", root: tilde(env, def.source.path), files: listTree(def.source.path) },
    ];
    for (const dp of placementsBySkill.get(def.name) ?? []) {
      const p = dp.placement;
      if (p.kind === "rendered-file" && fs.existsSync(p.path)) {
        variants.push({
          key: `${p.agent}`,
          label: `${p.agent}`,
          root: tilde(env, p.path),
          files: [{ path: path.basename(p.path), content: fs.readFileSync(p.path, "utf8") }],
          deployed: joinDrift(driftByPath, env, p.path),
        });
      }
    }
    units.push({
      id: `agent-${def.name}`,
      group: "Agent definitions",
      name: def.name,
      badges: ["agent", def.exportMode],
      variants,
    });
  }

  // ── Installed-now inventory: all registered agents' dirs ∪ state-file dirs ──
  const catalog = loadCatalogSpecs(config.roots);
  const dirIds = new Map<string, string>(); // resolved dir path → display id
  for (const [dirId, dir] of Object.entries(registry.directories)) {
    dirIds.set(expandTilde(env, dir.path), dirId);
  }
  for (const artifact of Object.values(state.artifacts)) {
    for (const p of artifact.placements ?? []) {
      const parent = path.dirname(p.path);
      if (!dirIds.has(parent)) dirIds.set(parent, tilde(env, parent));
    }
  }

  const rootsByRealPath = config.roots.map((r) => {
    try {
      return { root: r, real: fs.realpathSync(r.path) };
    } catch {
      return { root: r, real: r.path };
    }
  });

  const inventory: ReviewInvDir[] = [];
  for (const [dirPath, dirId] of [...dirIds.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    if (!fs.existsSync(dirPath)) continue;
    const entries: ReviewInvEntry[] = [];
    for (const name of fs.readdirSync(dirPath).sort()) {
      if (name.startsWith(".")) continue;
      const abs = path.join(dirPath, name);
      const st = fs.lstatSync(abs);
      if (!st.isSymbolicLink() && !st.isDirectory()) continue;
      let kind = "dir";
      let label = "unmanaged directory";
      if (st.isSymbolicLink()) {
        let target = "";
        try {
          target = fs.realpathSync(abs);
        } catch {
          kind = "broken";
          label = "broken symlink";
        }
        if (target) {
          const owner = rootsByRealPath.find((r) => target.startsWith(`${r.real}${path.sep}`));
          if (owner) {
            kind = owner.root.visibility;
            label = `ours · ${owner.root.visibility} root (${owner.root.name})`;
          } else if (catalog.bySkillName[name]) {
            kind = "upstream";
            label = `catalog-expected · ${catalog.bySkillName[name]}`;
          } else {
            kind = "link";
            label = `→ ${tilde(env, target)}`;
          }
        }
      } else if (state.artifacts[`skill:${name}`] || state.artifacts[`composed:${name}`]) {
        kind = "rendered";
        label = "skm-rendered (per-agent)";
      } else if (catalog.bySkillName[name]) {
        kind = "upstream";
        label = `catalog-expected · ${catalog.bySkillName[name]}`;
      }
      const doc = registerDoc(abs);
      const finding = driftByPath.get(path.resolve(abs));
      entries.push({
        name,
        kind,
        label,
        doc,
        drift: finding ? { path: tilde(env, abs), status: finding.drift, detail: finding.detail } : undefined,
      });
    }
    if (entries.length) inventory.push({ id: dirId, path: tilde(env, dirPath), entries });
  }

  return {
    reviewModelVersion: 1,
    built: env.clock.now(),
    machine: env.machineName,
    units,
    inventory,
    docs,
  };
}
