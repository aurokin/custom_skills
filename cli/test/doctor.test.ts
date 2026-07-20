// Doctor-specific scenarios: broken-link repair, rendered re-render, deny-guarantee
// verification against manually-corrupted state, and kill-switch suggestions.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { loadContext } from "../src/context";
import { diagnose, runDoctor } from "../src/doctor";
import { dirPath } from "../src/registry";
import { loadState, saveState, upsertPlacement } from "../src/state";
import type { VerbOptions } from "../src/types";
import { type Sandbox, makeAgentDef, makeAgentScopes, makeRoot, makeSandbox, makeSkill, writeMachineConfig } from "./util";

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
function homePath(...p: string[]): string {
  return path.join(sb.home, ...p);
}

test("--fix re-links a broken owned symlink", async () => {
  const root = makeRoot(sb, "public");
  const src = makeSkill(root.path, "s");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
  await runApply(sb.env, opts());

  // Break the claude symlink.
  const link = homePath(".claude/skills/s");
  fs.unlinkSync(link);
  fs.symlinkSync(homePath("nonexistent"), link);

  const c = loadContext(sb.env);
  expect(diagnose(sb.env, c.config, c.registry, c.desired, c.state).some((f) => f.category === "broken-link")).toBe(true);

  await runDoctor(sb.env, opts({ fix: true }));
  expect(fs.realpathSync(link)).toBe(fs.realpathSync(src));
});

test("--fix re-renders a hand-edited rendered artifact", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "r", { agentsYaml: { claude: { model: "opus" } } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
  await runApply(sb.env, opts());

  const md = homePath(".claude/skills/r/SKILL.md");
  fs.writeFileSync(md, "hand edited garbage\n");

  const c = loadContext(sb.env);
  expect(diagnose(sb.env, c.config, c.registry, c.desired, c.state).some((f) => f.category === "reconcile" && f.severity === "warn")).toBe(true);

  await runDoctor(sb.env, opts({ fix: true }));
  expect(fs.readFileSync(md, "utf8")).toContain("model: opus");
});

test("--fix records the full-tree hash when re-rendering (deletion-safety)", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "r", { agentsYaml: { claude: { model: "opus" } } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex"] });
  await runApply(sb.env, opts());

  const md = homePath(".claude/skills/r/SKILL.md");
  fs.writeFileSync(md, "hand edited garbage\n");

  await runDoctor(sb.env, opts({ fix: true }));

  // apply records `tree`; --fix must too, else the deletion-safety hole reopens
  // for this placement (a user file added alongside SKILL.md would be rm -rf'd).
  const placement = loadState(sb.env).artifacts["skill:r"]!.placements.find((p) => p.agent === "claude-code");
  expect(typeof placement?.tree).toBe("string");
});

test("deny-guarantee verification flags a skill resolvable from a denied agent's dir", () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "x");
  makeAgentScopes(root.path, { x: { agents: { deny: ["codex"] } } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex", "opencode"] });

  const c = loadContext(sb.env);
  // Corrupt state: pretend 'x' was (wrongly) placed in the shared dir, which codex reads.
  const state = loadState(sb.env);
  const sharedTarget = path.join(dirPath(sb.env, c.registry, "shared"), "x");
  upsertPlacement(state, "skill:x", { root: "public", visibility: "public" }, { agent: "shared", path: sharedTarget, kind: "symlink" });
  saveState(sb.env, state);

  const findings = diagnose(sb.env, c.config, c.registry, c.desired, loadState(sb.env));
  const violation = findings.find((f) => f.category === "deny-violation");
  expect(violation).toBeDefined();
  expect(violation?.message).toContain("codex");
});

test("deny-guarantee verification flags a DERIVED skill placed in a denied agent's dir", () => {
  const root = makeRoot(sb, "public");
  // export:skill def producing derived skill 'derived-x', excluding codex (→ deny).
  makeAgentDef(root.path, "dx-src", {
    agentYaml: { export: "skill", skill: { name: "derived-x" }, harness: { exclude: ["codex"] } },
  });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "codex", "opencode"] });

  const c = loadContext(sb.env);
  // Corrupt state: pretend the derived skill was (wrongly) placed in the shared dir,
  // which codex reads — a deny-guarantee violation the sweep must catch for derived
  // skills too, not only native ones.
  const state = loadState(sb.env);
  const sharedTarget = path.join(dirPath(sb.env, c.registry, "shared"), "derived-x");
  upsertPlacement(state, "skill:derived-x", { root: "public", visibility: "public" }, { agent: "shared", path: sharedTarget, kind: "rendered" });
  saveState(sb.env, state);

  const findings = diagnose(sb.env, c.config, c.registry, c.desired, loadState(sb.env));
  const violation = findings.find((f) => f.category === "deny-violation" && f.skill === "derived-x");
  expect(violation).toBeDefined();
  expect(violation?.message).toContain("codex");
});

test("suggests a kill switch when a scoped skill bleeds onto an agent that has one", () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "claude-only");
  makeAgentScopes(root.path, { "claude-only": { agents: { allow: ["claude-code"] } } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "opencode"] });

  const c = loadContext(sb.env);
  const findings = diagnose(sb.env, c.config, c.registry, c.desired, c.state);
  const suggestion = findings.find((f) => f.category === "env-suggestion");
  expect(suggestion).toBeDefined();
  expect(suggestion?.message).toContain("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS");
});

// ── Kill-switch env awareness + accepted shared-root exposures ──────────────

test("active kill-switch env suppresses the env suggestion and live exposure warn", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "claude-only");
  makeAgentScopes(root.path, { "claude-only": { agents: { allow: ["claude-code"] } } });
  makeSkill(root.path, "gated-x", { frontmatter: { "disable-model-invocation": true } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "opencode"] });
  await runApply(sb.env, opts());

  // Baseline: with no env var, both the bleed suggestion and the live gated
  // exposure warn fire (opencode reads the claude dir and ignores the gate).
  const base = loadContext(sb.env);
  const baseFindings = diagnose(sb.env, base.config, base.registry, base.desired, loadState(sb.env));
  expect(baseFindings.some((f) => f.category === "env-suggestion")).toBe(true);
  expect(baseFindings.some((f) => f.category === "gated-leak" && f.severity === "warn" && f.skill === "gated-x")).toBe(true);

  // With the opencode kill switch active in the environment, both are satisfied
  // mitigations, not findings.
  sb.env.envVar = (name) => (name === "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS" ? "1" : undefined);
  const c = loadContext(sb.env);
  const findings = diagnose(sb.env, c.config, c.registry, c.desired, loadState(sb.env));
  expect(findings.some((f) => f.category === "env-suggestion")).toBe(false);
  expect(findings.some((f) => f.category === "gated-leak" && f.severity === "warn" && f.skill === "gated-x")).toBe(false);
});

test("an empty-string kill-switch env var does not count as active", async () => {
  const root = makeRoot(sb, "public");
  makeSkill(root.path, "gated-x", { frontmatter: { "disable-model-invocation": true } });
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code", "opencode"] });
  await runApply(sb.env, opts());

  sb.env.envVar = (name) => (name === "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS" ? "" : undefined);
  const c = loadContext(sb.env);
  const findings = diagnose(sb.env, c.config, c.registry, c.desired, loadState(sb.env));
  expect(findings.some((f) => f.category === "gated-leak" && f.severity === "warn" && f.skill === "gated-x")).toBe(true);
});

test("acceptedGatedExposures downgrades the shared-root gated ERROR to info", () => {
  const root = makeRoot(sb, "public");
  writeMachineConfig(sb, {
    version: 1,
    roots: [root],
    agents: ["claude-code", "codex"],
    acceptedGatedExposures: ["grill-me"],
  });

  // A foreign (upstream-placed) gated skill sitting in the shared root.
  const c = loadContext(sb.env);
  const sharedDir = path.join(dirPath(sb.env, c.registry, "shared"), "grill-me");
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(
    path.join(sharedDir, "SKILL.md"),
    "---\nname: grill-me\ndescription: gated upstream skill\ndisable-model-invocation: true\n---\nbody\n",
  );

  const findings = diagnose(sb.env, c.config, c.registry, c.desired, loadState(sb.env));
  const forSkill = findings.filter((f) => f.category === "gated-leak" && f.skill === "grill-me");
  expect(forSkill.length).toBe(1);
  expect(forSkill[0]!.severity).toBe("info");
  expect(forSkill[0]!.message).toContain("accepted exposure");

  // A different unaccepted gated skill in the shared root still errors.
  const otherDir = path.join(dirPath(sb.env, c.registry, "shared"), "other-gated");
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(
    path.join(otherDir, "SKILL.md"),
    "---\nname: other-gated\ndescription: gated\ndisable-model-invocation: true\n---\nbody\n",
  );
  const findings2 = diagnose(sb.env, c.config, c.registry, c.desired, loadState(sb.env));
  expect(findings2.some((f) => f.category === "gated-leak" && f.skill === "other-gated" && f.severity === "error")).toBe(true);
});

test("acceptedGatedExposures downgrades the no-gate-own-dir gated ERROR to info", () => {
  const root = makeRoot(sb, "public");
  writeMachineConfig(sb, {
    version: 1,
    roots: [root],
    agents: ["claude-code", "hermes"],
    acceptedGatedExposures: ["grill-me"],
  });

  // The same accepted skill placed (unmanaged) in a no-gate agent's OWN dir —
  // hermes has gate "none", so without the acceptance this is the error branch.
  const c = loadContext(sb.env);
  const hermesDir = path.join(dirPath(sb.env, c.registry, "hermes"), "grill-me");
  fs.mkdirSync(hermesDir, { recursive: true });
  fs.writeFileSync(
    path.join(hermesDir, "SKILL.md"),
    "---\nname: grill-me\ndescription: gated upstream skill\ndisable-model-invocation: true\n---\nbody\n",
  );

  const findings = diagnose(sb.env, c.config, c.registry, c.desired, loadState(sb.env));
  const forSkill = findings.filter((f) => f.category === "gated-leak" && f.skill === "grill-me");
  expect(forSkill.length).toBe(1);
  expect(forSkill[0]!.severity).toBe("info");
  expect(forSkill[0]!.message).toContain("accepted exposure");
  expect(forSkill[0]!.message).toContain("hermes");

  // An unaccepted gated skill in the same dir still errors.
  const otherDir = path.join(dirPath(sb.env, c.registry, "hermes"), "other-gated");
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(
    path.join(otherDir, "SKILL.md"),
    "---\nname: other-gated\ndescription: gated\ndisable-model-invocation: true\n---\nbody\n",
  );
  const findings2 = diagnose(sb.env, c.config, c.registry, c.desired, loadState(sb.env));
  expect(findings2.some((f) => f.category === "gated-leak" && f.skill === "other-gated" && f.severity === "error")).toBe(true);
});
