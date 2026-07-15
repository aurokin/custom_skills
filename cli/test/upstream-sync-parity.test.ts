// Parity assertion for the `skm upstream sync` cutover (ADR 0014 implementation-plan
// item 4): the TS verb and the original install-repro-skills.sh run against IDENTICAL
// fixtures — same catalog/global-specs.txt, same `.skills.local.json` overrides, same
// installed-set JSON, same fixture home trees — and must produce the same `skills` CLI
// argv AND the same resulting filesystem state. The assertions target the DESTRUCTIVE
// EDGES the ADR enumerates, not just converged sets:
//   (i)  Hermes add-only: stale removal narrowed with `-a` to non-Hermes agents
//        (and skipped entirely in Hermes-only mode); the ~/.hermes/skills sweep
//        removes ONLY our own dangling symlinks — real dirs, live links, and
//        foreign-target danglers survive byte-identically on both sides.
//   (ii) the OpenClaw --dangerously-accept-openclaw-risks add flag,
//   (iii) diffwarden --full-depth,
//   (iv) preserveGlobalSkillNames protecting an installed stale name,
//   (v)  excludeGlobalSpecs: an excluded skill is not added AND is removed when
//        installed (exclusion is not preservation).
//
// No network / no real `skills` CLI: `git` is a shim that materializes a fixture
// SKILL.md layout, `skills` is a shim that records argv (and serves the installed
// list for `list -g --json`).

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { repoRootDir } from "./util";

// Upstream enumeration table shared by the git shim (both runners resolve whole-repo
// specs and coverage audits through it).
const UPSTREAM: Record<string, string[]> = {
  "keep/repo": ["keep-b"],
  "miss/repo": ["missing-c"],
  "openclaw/openclaw": ["github", "tmux"],
  "aurokin/diffwarden": ["diffwarden"],
  "wide/repo": ["w1", "w2", "w3"],
  "local/repo": ["local-extra"],
};

const GLOBAL_SPECS = [
  "keep/repo@keep-b",
  "miss/repo@missing-c",
  "openclaw/openclaw@github",
  "aurokin/diffwarden@diffwarden",
  "wide/repo",
].join("\n");

const LOCAL_CONFIG = {
  globalSpecs: ["local/repo@local-extra"],
  excludeGlobalSpecs: ["wide/repo@w2"],
  preserveGlobalSkillNames: ["handmade"],
};

const COVERAGE = {
  repos: [
    { repo: "wide/repo", ignored: [] },
    { repo: "keep/repo", ignored: [] },
  ],
};

const SYNC_SCRIPT = path.join(repoRootDir(), "install-repro-skills.sh");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const hasJq = spawnSync("bash", ["-c", "command -v jq"]).status === 0;
const hasScript = fs.existsSync(SYNC_SCRIPT);
const enabled = hasBash && hasJq && hasScript;

let base: string;
let fixtureRoot: string;
let upstreamJson: string;
let shimDir: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sync-parity-"));

  // Shared fixture root: catalog + local config + coverage manifest.
  fixtureRoot = path.join(base, "root");
  fs.mkdirSync(path.join(fixtureRoot, "catalog", "families"), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "catalog", "global-specs.txt"), `${GLOBAL_SPECS}\n`);
  fs.writeFileSync(path.join(fixtureRoot, ".skills.local.json"), JSON.stringify(LOCAL_CONFIG, null, 2));
  fs.writeFileSync(path.join(fixtureRoot, "upstream-coverage.json"), JSON.stringify(COVERAGE, null, 2));
  upstreamJson = path.join(base, "upstream.json");
  fs.writeFileSync(upstreamJson, JSON.stringify(UPSTREAM));

  // Shim bin dir shadowing `git` (fixture clone) and `skills` (argv recorder that
  // also serves the installed list for `list -g --json`).
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
  mkdir -p "$dest/$s"
  printf -- '---\\nname: %s\\n---\\n' "$s" > "$dest/$s/SKILL.md"
done < <(jq -r --arg r "$repo" '.[$r][]?' "$PARITY_UPSTREAM_JSON")
exit 0
`;
  const skillsShim = `#!/usr/bin/env bash
set -euo pipefail
line=""
for a in "$@"; do line="$line$a"$'\\x1f'; done
printf '%s\\n' "$line" >> "$PARITY_SKILLS_LOG"
if [ "\${1:-}" = "list" ]; then cat "$PARITY_INSTALLED_JSON"; fi
exit 0
`;
  fs.writeFileSync(path.join(shimDir, "git"), gitShim, { mode: 0o755 });
  fs.writeFileSync(path.join(shimDir, "skills"), skillsShim, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Build one fixture HOME with the sweep-edge content; returns its path. */
function buildHome(tag: string): string {
  const home = path.join(base, `home-${tag}`);
  const agentsSkills = path.join(home, ".agents", "skills");
  const claudeSkills = path.join(home, ".claude", "skills");
  const hermesSkills = path.join(home, ".hermes", "skills");
  fs.mkdirSync(agentsSkills, { recursive: true });
  fs.mkdirSync(claudeSkills, { recursive: true });
  fs.mkdirSync(hermesSkills, { recursive: true });

  // A live target for the hermes ours-valid link.
  fs.mkdirSync(path.join(agentsSkills, "alive"));
  // Owned-dir danglers (cleaned unconditionally on both sides).
  fs.symlinkSync(path.join(agentsSkills, "nonexistent"), path.join(agentsSkills, "dead-agents"));
  fs.symlinkSync(path.join(claudeSkills, "nonexistent"), path.join(claudeSkills, "dead-claude"));
  // Hermes edge content: OUR danglers (absolute + relative form), a foreign
  // dangler, a live our-link, and a real directory.
  fs.symlinkSync(path.join(agentsSkills, "gone"), path.join(hermesSkills, "ours-dangling-abs"));
  fs.symlinkSync("../../.agents/skills/gone2", path.join(hermesSkills, "ours-dangling-rel"));
  fs.symlinkSync("/nowhere/foreign-target", path.join(hermesSkills, "foreign-dangling"));
  fs.symlinkSync(path.join(agentsSkills, "alive"), path.join(hermesSkills, "ours-valid"));
  fs.mkdirSync(path.join(hermesSkills, "real-dir"));
  fs.writeFileSync(path.join(hermesSkills, "real-dir", "SKILL.md"), "hermes-owned\n");
  return home;
}

/** The installed-set JSON `skills list -g --json` serves for a given home. */
function writeInstalledJson(tag: string, home: string): string {
  const file = path.join(base, `installed-${tag}.json`);
  const inAgents = (n: string) => path.join(home, ".agents", "skills", n);
  fs.writeFileSync(
    file,
    JSON.stringify([
      { name: "stale-a", path: inAgents("stale-a") }, // stale → removed
      { name: "keep-b", path: inAgents("keep-b") }, // desired → kept
      { name: "handmade", path: inAgents("handmade") }, // preserved → kept
      { name: "w2", path: inAgents("w2") }, // excluded → removed
      { name: "elsewhere", path: path.join(home, "other", "skills", "elsewhere") }, // not global → invisible
    ]),
  );
  return file;
}

/** Snapshot a home tree: sorted "relpath type[ -> target]" lines, home-normalized. */
function snapshotHome(home: string): string[] {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(home, full);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(full).split(home).join("$HOME");
        lines.push(`${rel} link -> ${target}`);
      } else if (st.isDirectory()) {
        lines.push(`${rel} dir`);
        walk(full);
      } else {
        lines.push(`${rel} file`);
      }
    }
  };
  walk(home);
  return lines;
}

// ── runners ──────────────────────────────────────────────────────────────────

interface RunResult {
  argv: string[][];
  snapshot: string[];
}

function readArgvLog(log: string): string[][] {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\x1f").filter((f) => f.length > 0));
}

function runBash(tag: string, skillsAgents: string): RunResult {
  const home = buildHome(`bash-${tag}`);
  const log = path.join(base, `skills-bash-${tag}.log`);
  execFileSync("bash", [SYNC_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: home,
      SKILLS_AGENTS: skillsAgents,
      SKILLS_BIN: "skills",
      SKILL_CATALOG_DIR: path.join(fixtureRoot, "catalog"),
      LOCAL_SKILLS_CONFIG_FILE: path.join(fixtureRoot, ".skills.local.json"),
      UPSTREAM_COVERAGE_FILE: path.join(fixtureRoot, "upstream-coverage.json"),
      PARITY_UPSTREAM_JSON: upstreamJson,
      PARITY_SKILLS_LOG: log,
      PARITY_INSTALLED_JSON: writeInstalledJson(`bash-${tag}`, home),
    },
  });
  return { argv: readArgvLog(log), snapshot: snapshotHome(home) };
}

function runTs(tag: string, skillsAgents: string): RunResult {
  const home = buildHome(`ts-${tag}`);
  const xdgConfigHome = path.join(base, `xdg-config-ts-${tag}`);
  const xdgStateHome = path.join(base, `xdg-state-ts-${tag}`);
  fs.mkdirSync(path.join(xdgConfigHome, "skills-manager"), { recursive: true });
  fs.mkdirSync(xdgStateHome, { recursive: true });
  fs.writeFileSync(
    path.join(xdgConfigHome, "skills-manager", "config.json"),
    JSON.stringify({
      version: 1,
      roots: [{ name: "public", path: fixtureRoot, visibility: "public" }],
      agents: ["claude-code"],
    }),
  );

  // Subprocess: Bun resolves execFileSync binaries against the process's ORIGINAL
  // environ, so the shim must be first on PATH at process start (phase-3 precedent).
  const script = path.join(base, "ts-sync.ts");
  if (!fs.existsSync(script)) {
    const verbModule = path.join(repoRootDir(), "cli", "src", "upstream", "verb.ts");
    fs.writeFileSync(
      script,
      `import { runUpstream } from ${JSON.stringify(verbModule)};\n` +
        `const [home, xdgConfigHome, xdgStateHome] = process.argv.slice(2);\n` +
        `const out = await runUpstream(\n` +
        `  { home: home!, xdgConfigHome, xdgStateHome, machineName: "parity", clock: { now: () => "2026-07-15T00:00:00.000Z" } },\n` +
        `  { json: true, prune: false, yes: false, fix: false, args: ["sync"] },\n` +
        `);\n` +
        `process.stdout.write(JSON.stringify(out.json));\n`,
    );
  }
  const log = path.join(base, `skills-ts-${tag}.log`);
  execFileSync(process.execPath, [script, home, xdgConfigHome, xdgStateHome], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SKILLS_AGENTS: skillsAgents,
      SKILLS_BIN: "skills",
      UPSTREAM_COVERAGE_FILE: path.join(fixtureRoot, "upstream-coverage.json"),
      PARITY_UPSTREAM_JSON: upstreamJson,
      PARITY_SKILLS_LOG: log,
      PARITY_INSTALLED_JSON: writeInstalledJson(`ts-${tag}`, home),
    },
  });
  return { argv: readArgvLog(log), snapshot: snapshotHome(home) };
}

// ── comparison ───────────────────────────────────────────────────────────────

interface ArgvGroups {
  list: string[][];
  removes: string[][];
  update: string[][];
  adds: string[][];
}

/** Group recorded argv by subcommand, asserting the bash phase order
 *  (list → removes → update → adds) held in the raw sequence. */
function groupArgv(argv: string[][]): ArgvGroups {
  const groups: ArgvGroups = { list: [], removes: [], update: [], adds: [] };
  let phase = 0; // 0 list, 1 removes, 2 update, 3 adds
  const phaseOf: Record<string, number> = { list: 0, remove: 1, update: 2, add: 3 };
  for (const line of argv) {
    const sub = line[0]!;
    const p = phaseOf[sub];
    expect(p).toBeDefined();
    expect(p!).toBeGreaterThanOrEqual(phase);
    phase = p!;
    if (sub === "list") groups.list.push(line);
    else if (sub === "remove") groups.removes.push(line);
    else if (sub === "update") groups.update.push(line);
    else groups.adds.push(line);
  }
  return groups;
}

/** Removal order is a bash hash-iteration artifact: compare removals as sorted sets. */
function sortedLines(lines: string[][]): string[] {
  return lines.map((l) => l.join(" ")).sort();
}

function assertParity(bash: RunResult, ts: RunResult): { groups: ArgvGroups } {
  const bashGroups = groupArgv(bash.argv);
  const tsGroups = groupArgv(ts.argv);
  expect(tsGroups.list).toEqual(bashGroups.list);
  expect(sortedLines(tsGroups.removes)).toEqual(sortedLines(bashGroups.removes));
  expect(tsGroups.update).toEqual(bashGroups.update);
  expect(tsGroups.adds).toEqual(bashGroups.adds); // exact order: desired-spec order
  expect(ts.snapshot).toEqual(bash.snapshot);
  return { groups: tsGroups };
}

// ── scenarios ────────────────────────────────────────────────────────────────

describe.skipIf(!enabled)("skm upstream sync ↔ install-repro-skills.sh destructive-edge parity", () => {
  test("standard agents (no hermes): stale+excluded removed, preserves honored, extra add flags", () => {
    const agents = "codex claude-code";
    const { groups } = assertParity(runBash("std", agents), runTs("std", agents));

    // (iv) preserveGlobalSkillNames: installed 'handmade' is stale but never removed.
    // (v) excludeGlobalSpecs: installed 'w2' IS removed (exclusion is not preservation);
    //     'elsewhere' (outside ~/.agents/skills) is invisible to the diff.
    expect(sortedLines(groups.removes)).toEqual([
      "remove -g stale-a -a codex claude-code -y",
      "remove -g w2 -a codex claude-code -y",
    ]);
    // (ii)+(iii) extra flags after -y; (v) w2 not added from the expanded wide/repo.
    expect(groups.adds.map((l) => l.join(" "))).toEqual([
      "add miss/repo -g -a codex claude-code -s missing-c -y",
      "add openclaw/openclaw -g -a codex claude-code -s github -y --dangerously-accept-openclaw-risks",
      "add aurokin/diffwarden -g -a codex claude-code -s diffwarden -y --full-depth",
      "add wide/repo -g -a codex claude-code -s w1 w3 -y",
      "add local/repo -g -a codex claude-code -s local-extra -y",
    ]);
  });

  test("with hermes: removals narrowed to non-hermes agents; hermes sweep only touches ours", () => {
    const agents = "codex claude-code hermes-agent";
    const bash = runBash("hermes", agents);
    const ts = runTs("hermes", agents);
    const { groups } = assertParity(bash, ts);

    // (i) stale removal narrowed with -a to NON-hermes agents…
    for (const r of groups.removes) {
      expect(r).toContain("codex");
      expect(r).not.toContain("hermes-agent");
    }
    // …while adds fan out to the full agent set including hermes.
    for (const a of groups.adds) expect(a).toContain("hermes-agent");

    // (i) the hermes sweep: OUR danglers gone, foreign dangler + live link + real dir
    // survive — identically on both sides (assertParity already diffed snapshots;
    // these assert the absolute edge, not just convergence).
    const hermes = ts.snapshot.filter((l) => l.startsWith(path.join(".hermes", "skills")));
    const names = hermes.map((l) => l.split(" ")[0]);
    expect(names).not.toContain(path.join(".hermes", "skills", "ours-dangling-abs"));
    expect(names).not.toContain(path.join(".hermes", "skills", "ours-dangling-rel"));
    expect(names).toContain(path.join(".hermes", "skills", "foreign-dangling"));
    expect(names).toContain(path.join(".hermes", "skills", "ours-valid"));
    expect(names).toContain(path.join(".hermes", "skills", "real-dir"));
  });

  test("hermes-only mode: stale removal skipped entirely; adds still run", () => {
    const agents = "hermes-agent";
    const bash = runBash("hermes-only", agents);
    const ts = runTs("hermes-only", agents);
    const { groups } = assertParity(bash, ts);

    // (i) NEVER deletes when only hermes is enabled: zero `skills remove` calls.
    expect(groups.removes).toEqual([]);
    expect(groups.adds.length).toBeGreaterThan(0);
    for (const a of groups.adds) {
      expect(a.join(" ")).toContain("-a hermes-agent -s");
    }
  });

  test("no hermes in agents: the hermes dir is never touched at all", () => {
    const agents = "codex";
    const bash = runBash("no-hermes", agents);
    const ts = runTs("no-hermes", agents);
    assertParity(bash, ts);
    // All five fixture entries survive on both sides.
    const prefix = `${path.join(".hermes", "skills")}${path.sep}`;
    const hermesEntries = ts.snapshot.filter((l) => l.startsWith(prefix)).length;
    expect(hermesEntries).toBe(6); // 4 links + real-dir + its SKILL.md
  });
});

// Guard-rail: a skipped parity suite must be visible, never green-by-omission.
test("sync parity toolchain availability (informational)", () => {
  if (!enabled) {
    console.warn(`upstream-sync parity suite skipped: bash=${hasBash} jq=${hasJq} script=${hasScript}`);
  }
  expect(true).toBe(true);
});
