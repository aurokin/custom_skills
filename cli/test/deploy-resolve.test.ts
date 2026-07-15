// Unit tests for the pure `skm deploy` resolution path (ADR 0014 decision 3).
// Upstream enumeration (bash's git clone of a whole-repo spec) is a stub, so the
// resolver is exercised without git / network / the skills CLI.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type UpstreamEnumerator,
  batchToSkillsArgs,
  familyExists,
  listFamilies,
  loadDeployCatalog,
  resolveDeployPlan,
} from "../src/deploy/resolve";

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-resolve-"));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** Build a catalog dir + optional `.skills.local.json` under a fresh temp repo. */
function fixture(opts: {
  index?: string;
  families?: Record<string, string>;
  local?: unknown;
}): { catalogDir: string; configFile: string } {
  const catalogDir = path.join(base, "catalog");
  fs.mkdirSync(path.join(catalogDir, "families"), { recursive: true });
  if (opts.index !== undefined) fs.writeFileSync(path.join(catalogDir, "families.tsv"), opts.index);
  for (const [name, body] of Object.entries(opts.families ?? {})) {
    fs.writeFileSync(path.join(catalogDir, "families", `${name}.txt`), body);
  }
  const configFile = path.join(base, ".skills.local.json");
  if (opts.local !== undefined) fs.writeFileSync(configFile, JSON.stringify(opts.local, null, 2));
  return { catalogDir, configFile };
}

const noEnumerate: UpstreamEnumerator = (repo) => {
  throw new Error(`unexpected enumeration of ${repo}`);
};

function argsFor(plan: ReturnType<typeof resolveDeployPlan>): string[][] {
  return plan.batches.map((b) => batchToSkillsArgs(b, plan.agents));
}

describe("resolveDeployPlan — explicit specs", () => {
  test("batches explicit specs per repo in first-seen order (no enumeration)", () => {
    const { catalogDir, configFile } = fixture({
      index: "demo\tDemo family\n",
      families: { demo: "owner/repo@a\nowner/repo@b\nother/repo@x\n" },
    });
    const cat = loadDeployCatalog(catalogDir, configFile);
    const plan = resolveDeployPlan(
      { cat, families: ["demo"], agents: ["claude-code", "codex"], installRoot: "/proj" },
      noEnumerate,
    );
    expect(argsFor(plan)).toEqual([
      ["add", "owner/repo", "-a", "claude-code", "codex", "-s", "a", "b", "--copy", "-y"],
      ["add", "other/repo", "-a", "claude-code", "codex", "-s", "x", "--copy", "-y"],
    ]);
  });

  test("a whole-repo spec becomes an install-all batch", () => {
    const { catalogDir, configFile } = fixture({
      index: "demo\tDemo\n",
      families: { demo: "owner/repo\n" },
    });
    const cat = loadDeployCatalog(catalogDir, configFile);
    const plan = resolveDeployPlan({ cat, families: ["demo"], agents: ["codex"], installRoot: "/p" }, noEnumerate);
    expect(plan.batches).toEqual([{ repo: "owner/repo", skills: [] }]);
    expect(argsFor(plan)).toEqual([["add", "owner/repo", "-a", "codex", "--copy", "-y"]]);
  });
});

describe("resolveDeployPlan — .skills.local.json overrides", () => {
  test("familySpecs append to a curated family and dedupe", () => {
    const { catalogDir, configFile } = fixture({
      index: "demo\tDemo\n",
      families: { demo: "owner/repo@a\n" },
      local: { familySpecs: { demo: ["extra/repo@e", "owner/repo@a"] } },
    });
    const cat = loadDeployCatalog(catalogDir, configFile);
    const plan = resolveDeployPlan({ cat, families: ["demo"], agents: ["codex"], installRoot: "/p" }, noEnumerate);
    expect(plan.specs).toEqual(["owner/repo@a", "extra/repo@e"]);
  });

  test("custom families resolve from customFamilies specs", () => {
    const { catalogDir, configFile } = fixture({
      index: "demo\tDemo\n",
      families: { demo: "owner/repo@a\n" },
      local: { customFamilies: { mine: { description: "My custom", specs: ["c/r@c1", "c/r@c2"] } } },
    });
    const cat = loadDeployCatalog(catalogDir, configFile);
    expect(familyExists(cat, "mine")).toBe(true);
    const plan = resolveDeployPlan({ cat, families: ["mine"], agents: ["codex"], installRoot: "/p" }, noEnumerate);
    expect(argsFor(plan)).toEqual([["add", "c/r", "-a", "codex", "-s", "c1", "c2", "--copy", "-y"]]);
  });

  test("listFamilies lists curated (index order) then custom (insertion order)", () => {
    const { catalogDir, configFile } = fixture({
      index: "expo\tExpo family\nreact\tReact family\n",
      families: { expo: "e/r@x\n", react: "r/r@y\n" },
      local: { customFamilies: { mine: { description: "Mine", specs: ["c/r@c"] } } },
    });
    const cat = loadDeployCatalog(catalogDir, configFile);
    expect(listFamilies(cat)).toEqual([
      { name: "expo", description: "Expo family" },
      { name: "react", description: "React family" },
      { name: "mine", description: "Mine" },
    ]);
  });
});

describe("resolveDeployPlan — curated exclude / whole-repo expansion", () => {
  // Enumerate the fixture's whole-repo specs deterministically (stands in for git).
  const enumerate: UpstreamEnumerator = (repo) => {
    const table: Record<string, string[]> = {
      "wide/repo": ["a", "b", "c"],
      "mix/a": ["p", "q"],
      "mix/b": ["s1", "s2", "s3"],
    };
    const names = table[repo];
    if (!names) throw new Error(`no fixture enumeration for ${repo}`);
    return names;
  };

  test("partial exclusion collapses a whole-repo spec to surviving explicit specs", () => {
    const { catalogDir, configFile } = fixture({
      index: "wide\tWide\n",
      families: { wide: "wide/repo\n" },
      local: { excludeFamilySpecs: { wide: ["wide/repo@b"] } },
    });
    const cat = loadDeployCatalog(catalogDir, configFile);
    const plan = resolveDeployPlan({ cat, families: ["wide"], agents: ["codex"], installRoot: "/p" }, enumerate);
    expect(plan.specs).toEqual(["wide/repo@a", "wide/repo@c"]);
    expect(argsFor(plan)).toEqual([["add", "wide/repo", "-a", "codex", "-s", "a", "c", "--copy", "-y"]]);
  });

  test("a repo with nothing excluded is preserved whole-repo; a partial one collapses", () => {
    const { catalogDir, configFile } = fixture({
      index: "mix\tMix\n",
      families: { mix: "mix/a\nmix/b\n" },
      local: { excludeFamilySpecs: { mix: ["mix/b@s2"] } },
    });
    const cat = loadDeployCatalog(catalogDir, configFile);
    const plan = resolveDeployPlan({ cat, families: ["mix"], agents: ["codex"], installRoot: "/p" }, enumerate);
    expect(plan.specs).toEqual(["mix/a", "mix/b@s1", "mix/b@s3"]);
    expect(argsFor(plan)).toEqual([
      ["add", "mix/a", "-a", "codex", "--copy", "-y"],
      ["add", "mix/b", "-a", "codex", "-s", "s1", "s3", "--copy", "-y"],
    ]);
  });
});

describe("resolveDeployPlan — multiple families", () => {
  test("concatenates and dedupes specs across families", () => {
    const { catalogDir, configFile } = fixture({
      index: "one\tOne\ntwo\tTwo\n",
      families: { one: "shared/repo@a\n", two: "shared/repo@a\ntwo/repo@z\n" },
    });
    const cat = loadDeployCatalog(catalogDir, configFile);
    const plan = resolveDeployPlan(
      { cat, families: ["one", "two", "one"], agents: ["codex"], installRoot: "/p" },
      noEnumerate,
    );
    expect(plan.specs).toEqual(["shared/repo@a", "two/repo@z"]);
  });
});
