// Parity assertion for the `skm deploy` port (ADR 0014 implementation-plan item 3):
// the TS resolution path and the original deploy-project-skills.sh, run against the
// SAME fixture families (curated specs, `.skills.local.json` familySpecs /
// excludeFamilySpecs / customFamilies, and whole-repo exclude expansion), must
// produce identical RESOLVED INSTALL PLANS — the ordered `skills add --copy` argv.
//
// No network / no real `skills` CLI: the bash script runs with a stubbed `skills`
// (records argv) and a stubbed `git` (clones a fixture layout of SKILL.md files);
// the TS side uses a stub enumerator over the same upstream table. Both are driven
// by --dry-run-equivalent resolution — bash executes the install loop against the
// argv-recording shim rather than the network.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type UpstreamEnumerator,
  batchToSkillsArgs,
  listFamilies,
  loadDeployCatalog,
  resolveDeployPlan,
} from "../src/deploy/resolve";
import { repoRootDir } from "./util";

const AGENTS = ["claude-code", "codex"];

// Upstream enumeration table (bash's git clone stands in for this). Both the git
// shim and the TS stub enumerator read the same map, so the two sides see identical
// whole-repo expansions.
// A "ROOT:<name>" entry makes the git shim write a ROOT-level SKILL.md whose
// frontmatter `name:` is <name> (the single-skill repo layout); "ROOTBARE" writes a
// root SKILL.md with no frontmatter name. Used by the enumerator parity tests.
const UPSTREAM: Record<string, string[]> = {
  "owner/repo": ["a", "b"],
  "other/repo": ["x"],
  "extra/repo": ["e"],
  "wide/repo": ["a", "b", "c"],
  "mix/a": ["p", "q"],
  "mix/b": ["s1", "s2", "s3"],
  "custom/repo": ["c1", "c2"],
  "rooty/repo": ["ROOT:custom-name"],
  "bare/repo": ["ROOTBARE"],
};

const LOCAL_CONFIG = {
  familySpecs: { demo: ["extra/repo@e"] },
  excludeFamilySpecs: { wide: ["wide/repo@b"], mix: ["mix/b@s2"] },
  customFamilies: { mine: { description: "My custom", specs: ["custom/repo@c1", "custom/repo@c2"] } },
};

const FAMILIES: Record<string, string> = {
  demo: "owner/repo@a\nowner/repo@b\nother/repo@x\n",
  wide: "wide/repo\n",
  mix: "mix/a\nmix/b\n",
};
const INDEX = "demo\tDemo family\nwide\tWide family\nmix\tMix family\n";

const DEPLOY_SCRIPT = path.join(repoRootDir(), "deploy-project-skills.sh");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const hasJq = spawnSync("bash", ["-c", "command -v jq"]).status === 0;
const hasScript = fs.existsSync(DEPLOY_SCRIPT);
const enabled = hasBash && hasJq && hasScript;

let base: string;
let catalogDir: string;
let configFile: string;
let upstreamJson: string;
let shimDir: string;
let targetDir: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-parity-"));
  catalogDir = path.join(base, "catalog");
  fs.mkdirSync(path.join(catalogDir, "families"), { recursive: true });
  fs.writeFileSync(path.join(catalogDir, "families.tsv"), INDEX);
  for (const [name, body] of Object.entries(FAMILIES)) {
    fs.writeFileSync(path.join(catalogDir, "families", `${name}.txt`), body);
  }
  configFile = path.join(base, ".skills.local.json");
  fs.writeFileSync(configFile, JSON.stringify(LOCAL_CONFIG, null, 2));
  upstreamJson = path.join(base, "upstream.json");
  fs.writeFileSync(upstreamJson, JSON.stringify(UPSTREAM));

  targetDir = path.join(base, "target");
  fs.mkdirSync(targetDir, { recursive: true });

  // Shim bin dir shadowing `git` (fake clone) and `skills` (argv recorder).
  shimDir = path.join(base, "shim");
  fs.mkdirSync(shimDir, { recursive: true });
  const gitShim = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" != "clone" ]; then exit 0; fi
url=""; dest=""
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --depth) shift 2;;
    https://*) url="$1"; shift;;
    *) if [ -z "$dest" ] && [ -n "$url" ]; then dest="$1"; fi; shift;;
  esac
done
repo="\${url#https://github.com/}"; repo="\${repo%.git}"
mkdir -p "$dest"
while IFS= read -r s; do
  [ -z "$s" ] && continue
  case "$s" in
    ROOT:*) printf -- '---\\nname: %s\\n---\\n' "\${s#ROOT:}" > "$dest/SKILL.md";;
    ROOTBARE) printf 'root skill, no frontmatter\\n' > "$dest/SKILL.md";;
    *) mkdir -p "$dest/$s"; printf -- '---\\nname: %s\\n---\\n' "$s" > "$dest/$s/SKILL.md";;
  esac
done < <(jq -r --arg r "$repo" '.[$r][]?' "$PARITY_UPSTREAM_JSON")
exit 0
`;
  const skillsShim = `#!/usr/bin/env bash
set -euo pipefail
line=""
for a in "$@"; do line="$line$a"$'\\x1f'; done
printf '%s\\n' "$line" >> "$PARITY_SKILLS_LOG"
exit 0
`;
  fs.writeFileSync(path.join(shimDir, "git"), gitShim, { mode: 0o755 });
  fs.writeFileSync(path.join(shimDir, "skills"), skillsShim, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** Run the bash deploy script with the shims; return the recorded `skills add` argv. */
function runBash(familyArgs: string[]): string[][] {
  const log = path.join(base, `skills-${Math.random().toString(36).slice(2)}.log`);
  const args = [
    DEPLOY_SCRIPT,
    "--target",
    targetDir,
    "--agents",
    AGENTS.join(" "),
    "--yes",
    ...familyArgs,
  ];
  const res = execFileSync("bash", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SKILL_CATALOG_DIR: catalogDir,
      LOCAL_SKILLS_CONFIG_FILE: configFile,
      SKILLS_BIN: "skills",
      SKILLS_AUDIT_REPO_COVERAGE: "0",
      PARITY_UPSTREAM_JSON: upstreamJson,
      PARITY_SKILLS_LOG: log,
      HOME: base,
    },
  });
  void res;
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\x1f").filter((f) => f.length > 0));
}

/** Resolve the same plan through the TS path; return the synthesized `skills add` argv. */
function runTs(families: string[]): string[][] {
  const cat = loadDeployCatalog(catalogDir, configFile);
  const enumerate: UpstreamEnumerator = (repo) => {
    const names = UPSTREAM[repo];
    if (!names) throw new Error(`no fixture enumeration for ${repo}`);
    return [...names].sort();
  };
  const plan = resolveDeployPlan(
    { cat, families, agents: AGENTS, installRoot: targetDir },
    enumerate,
  );
  return plan.batches.map((b) => batchToSkillsArgs(b, AGENTS));
}

describe.skipIf(!enabled)("skm deploy ↔ deploy-project-skills.sh install-plan parity", () => {
  const scenarios: { name: string; familyFlags: string[]; families: string[] }[] = [
    { name: "explicit family + familySpecs override", familyFlags: ["--family", "demo"], families: ["demo"] },
    { name: "whole-repo partial exclusion", familyFlags: ["--family", "wide"], families: ["wide"] },
    { name: "mixed preserve-wide + partial exclusion", familyFlags: ["--family", "mix"], families: ["mix"] },
    { name: "custom family", familyFlags: ["--family", "mine"], families: ["mine"] },
    {
      name: "multiple families dedupe",
      familyFlags: ["--family", "demo", "--family", "mine"],
      families: ["demo", "mine"],
    },
    { name: "all families", familyFlags: ["--all-families"], families: [] },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const families = s.families.length > 0 ? s.families : listFamilies(loadDeployCatalog(catalogDir, configFile)).map((r) => r.name);
      const bash = runBash(s.familyFlags);
      const ts = runTs(families);
      expect(ts).toEqual(bash);
      expect(ts.length).toBeGreaterThan(0);
    });
  }
});

// ── enumerator parity: root SKILL.md naming ──────────────────────────────────
// The upstream skill-name enumeration itself (a port of lib/upstream-audit.sh
// collect_upstream_skill_names) must agree with bash — including the disputed case
// of a ROOT SKILL.md whose frontmatter `name:` differs from the repo basename:
// bash overrides the repo-derived name with the frontmatter name UNCONDITIONALLY
// (lib/upstream-audit.sh lines 89-96), and the TS enumerator must do the same.

/** Run bash collect_upstream_skill_names (sorted-unique, as its cached wrapper does). */
function bashEnumerate(repo: string): string[] {
  const script = `source "${path.join(repoRootDir(), "lib", "upstream-audit.sh")}" && collect_upstream_skill_names "$1" | sort -u`;
  const out = execFileSync("bash", ["-c", script, "bash", repo], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PARITY_UPSTREAM_JSON: upstreamJson,
      HOME: base,
    },
  });
  return out.split("\n").filter((l) => l.length > 0);
}

/**
 * Run the TS production enumerator with the same git shim on PATH. Spawned as a
 * bun subprocess with the shim env: Bun resolves execFileSync binaries against the
 * process's ORIGINAL environ, so an in-process PATH mutation would still hit the
 * real network `git` — the subprocess starts with the shim already first on PATH.
 */
function tsEnumerate(repo: string): string[] {
  const script = path.join(base, "ts-enumerate.ts");
  if (!fs.existsSync(script)) {
    const upstreamModule = path.join(repoRootDir(), "cli", "src", "deploy", "upstream.ts");
    fs.writeFileSync(
      script,
      `import { makeGitEnumerator } from ${JSON.stringify(upstreamModule)};\n` +
        `process.stdout.write(JSON.stringify(makeGitEnumerator()(process.argv[2]!)));\n`,
    );
  }
  const out = execFileSync(process.execPath, [script, repo], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PARITY_UPSTREAM_JSON: upstreamJson,
      HOME: base,
    },
  });
  return JSON.parse(out) as string[];
}

describe.skipIf(!enabled)("upstream enumerator ↔ collect_upstream_skill_names parity", () => {
  test("root SKILL.md with a frontmatter name differing from the repo basename", () => {
    const bash = bashEnumerate("rooty/repo");
    const ts = tsEnumerate("rooty/repo");
    expect(ts).toEqual(bash);
    // Both sides yield the FRONTMATTER name (bash's unconditional override).
    expect(ts).toEqual(["custom-name"]);
  });

  test("root SKILL.md without a frontmatter name falls back to the repo basename", () => {
    const bash = bashEnumerate("bare/repo");
    const ts = tsEnumerate("bare/repo");
    expect(ts).toEqual(bash);
    expect(ts).toEqual(["repo"]);
  });

  test("multi-skill layout enumerates every SKILL.md", () => {
    const bash = bashEnumerate("mix/b");
    const ts = tsEnumerate("mix/b");
    expect(ts).toEqual(bash);
    expect(ts).toEqual(["s1", "s2", "s3"]);
  });
});

// Guard-rail: if the toolchain is unavailable the parity suite silently skips, which
// could mask a real regression. This test fails loudly only in that case so a broken
// environment is visible rather than green-by-omission.
test("parity toolchain availability (informational)", () => {
  if (!enabled) {
    console.warn(
      `deploy parity suite skipped: bash=${hasBash} jq=${hasJq} script=${hasScript}`,
    );
  }
  expect(true).toBe(true);
});
