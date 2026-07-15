// The impure edge of `skm deploy`: enumerating a whole-repo spec's upstream skill
// names (git clone + SKILL.md walk, a port of lib/upstream-audit.sh
// collect_upstream_skill_names) and the curated-family coverage audit
// (load_coverage_manifest_into_maps + audit_repo_skill_coverage). The resolver
// takes enumeration as an injected callback; this module is the production wiring.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UpstreamEnumerator } from "./resolve";

/** owner/name from a spec repo (first two segments); the rest is the GitHub subdir. */
function cloneRepoAndSubdir(repo: string): { clone: string; subdir: string } {
  const parts = repo.split("/");
  return { clone: `${parts[0]}/${parts[1]}`, subdir: parts.slice(2).join("/") };
}

/** extract_skill_frontmatter_name: the `name:` from a SKILL.md's leading YAML block. */
function frontmatterName(skillFile: string): string {
  let text: string;
  try {
    text = fs.readFileSync(skillFile, "utf8");
  } catch {
    return "";
  }
  const lines = text.split("\n");
  let inYaml = false;
  for (const line of lines) {
    if (line === "---") {
      if (!inYaml) {
        inYaml = true;
        continue;
      }
      break;
    }
    const m = inYaml ? /^name:[ \t]*(.*)$/.exec(line) : null;
    if (m) return m[1]!.replace(/^["']|["']$/g, "").trim();
  }
  return "";
}

/** Recursively list every SKILL.md under `dir`, skipping .git trees. */
function findSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git") continue;
        walk(full);
      } else if (e.isFile() && e.name === "SKILL.md") {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Production enumerator: shallow-clone `<repo>` and enumerate its skill names,
 * mirroring collect_upstream_skill_names (root SKILL.md ⇒ single skill named after
 * the repo; otherwise every SKILL.md, named by frontmatter or its parent dir).
 * Results are sorted-unique. Throws on clone failure / empty layout. Memoized per
 * process so a repo referenced by several specs clones once.
 */
export function makeGitEnumerator(): UpstreamEnumerator {
  const cache = new Map<string, string[]>();
  return (repo: string): string[] => {
    const cached = cache.get(repo);
    if (cached) return cached;

    const { clone, subdir } = cloneRepoAndSubdir(repo);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skm-deploy-"));
    const repoDir = path.join(tmp, "repo");
    try {
      try {
        execFileSync("git", ["clone", "--depth", "1", `https://github.com/${clone}.git`, repoDir], {
          stdio: "ignore",
        });
      } catch {
        throw new Error(`Failed to expand repo-wide skill spec: ${repo}`);
      }
      const searchDir = subdir ? path.join(repoDir, subdir) : repoDir;
      if (subdir && !fs.existsSync(searchDir)) {
        throw new Error(`Skill subdirectory not found in ${repo}: ${subdir}`);
      }
      const rootSkill = path.join(searchDir, "SKILL.md");
      const hasRoot = fs.existsSync(rootSkill);
      const names = new Set<string>();
      for (const file of findSkillFiles(searchDir)) {
        if (hasRoot && file !== rootSkill) continue;
        let name = file === rootSkill ? path.basename(repo) : path.basename(path.dirname(file));
        const fm = frontmatterName(file);
        if (fm) name = fm;
        names.add(name);
      }
      if (names.size === 0) throw new Error(`No SKILL.md files found in ${repo}; repo layout may have changed`);
      const sorted = [...names].sort();
      cache.set(repo, sorted);
      return sorted;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

// ── coverage audit (family repo coverage drift) ──────────────────────────────

export interface CoverageManifest {
  /** Repo order as declared in the manifest. */
  repos: string[];
  /** repo → ignored skill names. */
  ignored: Map<string, string[]>;
}

/** load_coverage_manifest_into_maps: parse catalog/family-coverage.json; undefined when invalid. */
export function loadCoverageManifest(file: string): CoverageManifest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const reposRaw = (raw as { repos?: unknown }).repos;
  if (!Array.isArray(reposRaw)) return undefined;
  const repos: string[] = [];
  const ignored = new Map<string, string[]>();
  for (const entry of reposRaw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const repo = (entry as { repo?: unknown }).repo;
    if (typeof repo !== "string" || repo.length === 0) return undefined;
    const ig = (entry as { ignored?: unknown }).ignored ?? [];
    if (!Array.isArray(ig)) return undefined;
    repos.push(repo);
    ignored.set(repo, ig.map(String));
  }
  return { repos, ignored };
}

/**
 * audit_repo_skill_coverage for one repo: compare the declared + ignored skills to
 * the upstream enumeration, returning the drift warnings (undeclared upstream skills
 * and declared-but-missing skills). Empty ⇒ no drift.
 */
export function auditRepoSkillCoverage(
  repo: string,
  declared: string[],
  ignored: string[],
  enumerate: UpstreamEnumerator,
): string[] {
  const declaredSet = new Set(declared);
  const ignoredSet = new Set(ignored);
  const upstream = enumerate(repo);
  const upstreamSet = new Set(upstream);

  const unexpected = upstream.filter((n) => !declaredSet.has(n) && !ignoredSet.has(n));
  const missing = [...declaredSet].filter((n) => !upstreamSet.has(n));

  const warnings: string[] = [];
  if (unexpected.length > 0) warnings.push(`Undeclared upstream skill(s) in ${repo}: ${unexpected.join(" ")}`);
  if (missing.length > 0) warnings.push(`Declared skill(s) no longer found in ${repo}: ${missing.join(" ")}`);
  return warnings;
}
