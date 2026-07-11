// Regression: the reviewed-plan integrity hash (planHash) must cover the fields
// that determine WHAT lands on disk — the source path and frontmatter overrides —
// not just the target path/kind. Otherwise a reviewed plan file could be repointed
// at attacker content and still pass the integrity check (works-1).

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { buildPlan } from "../src/plan";
import { loadContext } from "../src/context";
import { resolveDesiredState } from "../src/resolve";
import type { VerbOptions } from "../src/types";
import { type Sandbox, makeRoot, makeSandbox, makeSkill, writeMachineConfig } from "./util";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.cleanup();
});

function opts(over: Partial<VerbOptions> = {}): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: [], ...over };
}

test("apply --plan: repointing an action's source.path is caught by the integrity check", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "legit"); // the reviewed source
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

  const c = loadContext(sb.env);
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  const planFile = path.join(sb.base, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));

  // Attacker stages a malicious skill dir and repoints one action at it, leaving
  // placement.path / kind / hash / desiredStateHash / planHash untouched.
  const evilDir = path.join(sb.base, "evil");
  fs.mkdirSync(evilDir, { recursive: true });
  fs.writeFileSync(path.join(evilDir, "SKILL.md"), "---\nname: legit\n---\nPWNED\n");

  const tampered = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const victim = tampered.actions.find(
    (a: any) => a.skill === "legit" && a.placement.agent === "claude-code",
  );
  victim.source.path = evilDir; // the tamper: repoint what gets symlinked
  fs.writeFileSync(planFile, JSON.stringify(tampered));

  // The integrity check now covers source.path, so the recomputed planHash differs
  // and apply refuses before touching disk.
  await expect(runApply(sb.env, opts({ planFile }))).rejects.toThrow(/integrity check/);

  const placed = path.join(sb.home, ".claude/skills/legit");
  expect(fs.existsSync(placed)).toBe(false); // evil content never landed
});

// Finding 4: the integrity hash must cover EVERY semantics-bearing field of an
// action, not just target path/kind/source.path. Each of these tampers used to
// slip past the check: source.visibility (privacy-guard bypass), placement.dir
// (dialect/override merge), placement.agent (hermes prune exemption).
for (const tamper of [
  {
    name: "source.visibility (private→public strips the privacy guard)",
    root: () => makeRoot(sb, "priv", "private"),
    mutate: (a: any) => {
      a.source.visibility = "public";
    },
  },
  {
    name: "placement.dir (alters rendering dialect / override merge)",
    root: () => makeRoot(sb, "public"),
    mutate: (a: any) => {
      a.placement.dir = "codex";
    },
  },
  {
    name: "placement.agent (flips hermes prune exemption / ownership label)",
    root: () => makeRoot(sb, "public"),
    mutate: (a: any) => {
      a.placement.agent = "hermes";
    },
  },
]) {
  test(`apply --plan: tampering ${tamper.name} is caught by the integrity check`, async () => {
    const root = tamper.root();
    makeSkill(root.path, "legit");
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

    const c = loadContext(sb.env);
    const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
    const planFile = path.join(sb.base, "plan.json");
    fs.writeFileSync(planFile, JSON.stringify(plan));

    const tampered = JSON.parse(fs.readFileSync(planFile, "utf8"));
    const victim = tampered.actions.find(
      (a: any) => a.skill === "legit" && a.placement.agent === "claude-code",
    );
    tamper.mutate(victim);
    fs.writeFileSync(planFile, JSON.stringify(tampered));

    await expect(runApply(sb.env, opts({ planFile }))).rejects.toThrow(/integrity check/);
  });
}

// Finding 1: a reviewed --plan rendered action carries the hash that was reviewed.
// The desired-state precondition covers the source PATH but not its bytes, so a
// source/override edit in the plan→apply gap must be caught at materialization by
// comparing the freshly rendered hash to the reviewed one — refuse, never write.
test("apply --plan: a source edit that changes rendered bytes is refused, not materialized", async () => {
  const root = makeRoot(sb, "public");
  const skillDir = makeSkill(root.path, "rendered-skill", {
    agentsYaml: { claude: { model: "opus" } },
  });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });

  const c = loadContext(sb.env);
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);
  const planFile = path.join(sb.base, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));

  const claudeAction = plan.actions.find(
    (a) => a.skill === "rendered-skill" && a.placement.agent === "claude-code",
  );
  expect(claudeAction?.placement.kind).toBe("rendered");

  // Attacker rewrites the source AFTER review. Path/override-keys are unchanged, so
  // the --plan desired-state precondition still passes.
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: rendered-skill\ndescription: rendered-skill skill\n---\n\nPWNED unreviewed body\n",
  );
  const desiredAfter = resolveDesiredState(sb.env, c.config, c.registry);
  expect(desiredAfter.hash).toBe(plan.desiredStateHash);

  const outcome = await runApply(sb.env, opts({ planFile }));

  const claudeDir = path.join(sb.home, ".claude", "skills", "rendered-skill");
  if (fs.existsSync(path.join(claudeDir, "SKILL.md"))) {
    expect(fs.readFileSync(path.join(claudeDir, "SKILL.md"), "utf8")).not.toContain("PWNED");
  }
  const summary = outcome.json as { refused: { drift: string; skill?: string }[] };
  expect(summary.refused.some((r) => r.skill === "rendered-skill")).toBe(true);
  expect(outcome.exitCode).toBe(2); // refusal → non-convergence
});
