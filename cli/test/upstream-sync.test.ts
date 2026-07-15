// Unit tests for the pure `skm upstream sync` pieces (ADR 0014 decision 4):
// desired-spec resolution, the remove-stale/add-missing plan (with the per-repo
// extra flags and Hermes narrowing), and the two broken-symlink sweeps.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UpstreamEnumerator } from "../src/deploy/resolve";
import {
  addBatchToSkillsArgs,
  buildRepoSkillSummary,
  buildSyncPlan,
  readGlobalSpecsFile,
  removalToSkillsArgs,
  resolveDesiredGlobalSpecs,
  sweepBrokenSymlinks,
  sweepHermesBrokenSymlinks,
} from "../src/upstream/sync";
import type { LocalSkillsConfig } from "../src/deploy/local-config";

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sync-"));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const emptyLocal: LocalSkillsConfig = {
  present: false,
  globalSpecs: [],
  excludeGlobalSpecs: [],
  preserveGlobalSkillNames: [],
  familySpecs: {},
  excludeFamilySpecs: {},
  customFamilies: {},
};

const noEnumerate: UpstreamEnumerator = (repo) => {
  throw new Error(`unexpected enumeration of ${repo}`);
};

describe("readGlobalSpecsFile / resolveDesiredGlobalSpecs", () => {
  test("invalid spec lines fail loudly with file:line", () => {
    const f = path.join(base, "global-specs.txt");
    fs.writeFileSync(f, "ok/spec@a\nnot a spec\n");
    expect(() => readGlobalSpecsFile(f)).toThrow(/Invalid skill spec in .*global-specs.txt:2/);
  });

  test("local globalSpecs append and excludeGlobalSpecs filter (whole-repo expansion)", () => {
    const f = path.join(base, "global-specs.txt");
    fs.writeFileSync(f, "keep/repo@keep\nwide/repo\n");
    const local: LocalSkillsConfig = {
      ...emptyLocal,
      present: true,
      globalSpecs: ["local/repo@extra"],
      excludeGlobalSpecs: ["wide/repo@w2"],
    };
    const enumerate: UpstreamEnumerator = (repo) => {
      if (repo === "wide/repo") return ["w1", "w2", "w3"];
      throw new Error(`unexpected ${repo}`);
    };
    const { desiredSpecs, resolvedExcludedSpecs } = resolveDesiredGlobalSpecs(f, local, enumerate);
    expect(desiredSpecs).toEqual(["keep/repo@keep", "wide/repo@w1", "wide/repo@w3", "local/repo@extra"]);
    expect(resolvedExcludedSpecs).toEqual(["wide/repo@w2"]);
  });

  test("a whole-repo exclude resolves to every expanded spec of that repo", () => {
    const f = path.join(base, "global-specs.txt");
    fs.writeFileSync(f, "wide/repo\nkeep/repo@keep\n");
    const local: LocalSkillsConfig = { ...emptyLocal, present: true, excludeGlobalSpecs: ["wide/repo"] };
    const enumerate: UpstreamEnumerator = () => ["w1", "w2"];
    const { desiredSpecs } = resolveDesiredGlobalSpecs(f, local, enumerate);
    expect(desiredSpecs).toEqual(["keep/repo@keep"]);
  });
});

describe("buildSyncPlan", () => {
  const desired = ["keep/repo@keep-b", "openclaw/openclaw@github", "aurokin/diffwarden@diffwarden"];

  test("stale names removed, preserved kept, missing batched with extra flags", () => {
    const plan = buildSyncPlan({
      desiredSpecs: desired,
      preservedNames: ["handmade"],
      installedNames: ["stale-a", "keep-b", "handmade"],
      nonHermesAgents: ["codex"],
    });
    expect(plan.removals).toEqual(["stale-a"]);
    expect(plan.preservedInstalled).toEqual(["handmade"]);
    expect(plan.skipStaleRemoval).toBe(false);
    expect(plan.addBatches).toEqual([
      { repo: "openclaw/openclaw", skills: ["github"], extraArgs: ["--dangerously-accept-openclaw-risks"] },
      { repo: "aurokin/diffwarden", skills: ["diffwarden"], extraArgs: ["--full-depth"] },
    ]);
  });

  test("hermes-only mode skips stale removal entirely", () => {
    const plan = buildSyncPlan({
      desiredSpecs: desired,
      preservedNames: [],
      installedNames: ["stale-a"],
      nonHermesAgents: [],
    });
    expect(plan.skipStaleRemoval).toBe(true);
    expect(plan.removals).toEqual([]);
    // Adds are unaffected: Hermes installs are add-only, not add-never.
    expect(plan.addBatches.map((b) => b.repo)).toEqual([
      "keep/repo",
      "openclaw/openclaw",
      "aurokin/diffwarden",
    ]);
  });

  test("argv shapes match the bash invocations (extra flags after -y)", () => {
    expect(removalToSkillsArgs("stale-a", ["codex", "opencode"])).toEqual([
      "remove", "-g", "stale-a", "-a", "codex", "opencode", "-y",
    ]);
    expect(
      addBatchToSkillsArgs(
        { repo: "openclaw/openclaw", skills: ["github", "tmux"], extraArgs: ["--dangerously-accept-openclaw-risks"] },
        ["codex", "hermes-agent"],
      ),
    ).toEqual([
      "add", "openclaw/openclaw", "-g", "-a", "codex", "hermes-agent",
      "-s", "github", "tmux", "-y", "--dangerously-accept-openclaw-risks",
    ]);
  });
});

describe("sweeps", () => {
  test("owned-dir sweep removes only dangling symlinks", () => {
    const dir = path.join(base, "owned");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "real-dir"));
    fs.writeFileSync(path.join(dir, "target-file"), "x");
    fs.symlinkSync(path.join(dir, "target-file"), path.join(dir, "live-link"));
    fs.symlinkSync(path.join(dir, "nonexistent"), path.join(dir, "dead-link"));
    expect(sweepBrokenSymlinks(dir)).toEqual(["dead-link"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["live-link", "real-dir", "target-file"]);
  });

  test("hermes sweep removes only OUR dangling links; foreign/real/live untouched", () => {
    const home = path.join(base, "home");
    const hermes = path.join(home, ".hermes", "skills");
    const agentsSkills = path.join(home, ".agents", "skills");
    fs.mkdirSync(hermes, { recursive: true });
    fs.mkdirSync(path.join(agentsSkills, "alive"), { recursive: true });

    fs.symlinkSync(path.join(agentsSkills, "gone"), path.join(hermes, "ours-dangling-abs"));
    fs.symlinkSync("../../.agents/skills/gone2", path.join(hermes, "ours-dangling-rel"));
    fs.symlinkSync("/nowhere/foreign-target", path.join(hermes, "foreign-dangling"));
    fs.symlinkSync(path.join(agentsSkills, "alive"), path.join(hermes, "ours-valid"));
    fs.mkdirSync(path.join(hermes, "real-dir"));

    const removed = sweepHermesBrokenSymlinks(hermes, [
      `${path.join(base, "repo", "skills")}/`,
      `${agentsSkills}/`,
      "../../.agents/skills/",
    ]);
    expect(removed).toEqual(["ours-dangling-abs", "ours-dangling-rel"]);
    expect(fs.readdirSync(hermes).sort()).toEqual(["foreign-dangling", "ours-valid", "real-dir"]);
  });

  test("missing dirs are a no-op", () => {
    expect(sweepBrokenSymlinks(path.join(base, "nope"))).toEqual([]);
    expect(sweepHermesBrokenSymlinks(path.join(base, "nope"), ["/x/"])).toEqual([]);
  });
});

describe("buildRepoSkillSummary", () => {
  test("marks full coverage only when declared equals the upstream enumeration", () => {
    const enumerate: UpstreamEnumerator = (repo) =>
      repo === "full/repo" ? ["a", "b"] : ["x", "y", "z"];
    const summary = buildRepoSkillSummary(["full/repo@b", "full/repo@a", "part/repo@x"], enumerate);
    expect(summary).toEqual([
      { repo: "full/repo", skills: ["a", "b"], fullCoverage: true },
      { repo: "part/repo", skills: ["x"], fullCoverage: false },
    ]);
  });

  test("propagates enumeration failure (summary resolves before any mutation)", () => {
    expect(() => buildRepoSkillSummary(["x/y@a"], noEnumerate)).toThrow(/unexpected enumeration/);
  });
});
