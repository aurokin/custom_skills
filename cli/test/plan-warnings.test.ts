// Regression: a private-visibility skill with no scoping lands in the world-readable
// shared dir (per-spec: scoping, not visibility, restricts agents), but plan must
// surface a warning rather than doing it silently
// (privacy-unscoped-private-goes-to-shared-unflagged).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildPlan } from "../src/plan";
import { loadContext } from "../src/context";
import { type Sandbox, makeRoot, makeSandbox, makeSkill, writeMachineConfig } from "./util";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.cleanup();
});

test("plan warns when an unscoped private skill lands in the shared dir", () => {
  const priv = makeRoot(sb, "private", "private");
  makeSkill(priv.path, "secret-util"); // unscoped, private
  writeMachineConfig(sb, { version: 1, roots: [priv], agents: ["claude-code", "codex"] });

  const c = loadContext(sb.env);
  const plan = buildPlan(sb.env, c.config, c.registry, c.desired, c.state);

  // It IS placed in shared (spec-conformant), and that placement is warned about.
  expect(plan.actions.some((a) => a.placement.agent === "shared" && a.skill === "secret-util")).toBe(true);
  const warning = plan.warnings.find((w) => w.kind === "unscoped-shared" && w.skill === "secret-util");
  expect(warning).toBeDefined();
});
