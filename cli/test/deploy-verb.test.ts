// Verb-level regressions for `skm deploy` (ADR 0014): it must bootstrap from the
// machine config alone (never state.json / desired-state — the ownership boundary),
// and reject a malformed multi-target invocation instead of silently using args[0].

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runDeploy } from "../src/deploy/verb";
import { statePath } from "../src/env";
import { UsageError } from "../src/errors";
import type { VerbOptions } from "../src/types";
import { type Sandbox, makeRoot, makeSandbox, writeMachineConfig } from "./util";

let sb: Sandbox;
let publicRootPath: string;
let target: string;

beforeEach(() => {
  sb = makeSandbox();
  const root = makeRoot(sb, "public", "public");
  publicRootPath = root.path;
  fs.mkdirSync(path.join(publicRootPath, "catalog", "families"), { recursive: true });
  fs.writeFileSync(path.join(publicRootPath, "catalog", "families.tsv"), "demo\tDemo family\n");
  fs.writeFileSync(path.join(publicRootPath, "catalog", "families", "demo.txt"), "owner/repo@a\n");
  writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"], privateOriginAllowlist: [] });
  target = path.join(sb.base, "target");
  fs.mkdirSync(target, { recursive: true });
});
afterEach(() => sb.cleanup());

function opts(over: Partial<VerbOptions>): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: [], ...over };
}

describe("runDeploy bootstrap", () => {
  test("--list-families succeeds even with a corrupt state.json (state never read)", async () => {
    const sp = statePath(sb.env);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, "{ this is not valid json");
    const out = await runDeploy(sb.env, opts({ listFamilies: true }));
    expect(out.exitCode).toBe(0);
    expect((out.json as { families: { name: string }[] }).families.map((f) => f.name)).toEqual(["demo"]);
  });

  test("--dry-run resolves the plan without executing", async () => {
    const out = await runDeploy(
      sb.env,
      opts({ args: [target], families: ["demo"], agentsList: "claude-code", dryRun: true }),
    );
    expect(out.exitCode).toBe(0);
    const json = out.json as { executed: boolean; batches: { repo: string; skills: string[] }[] };
    expect(json.executed).toBe(false);
    expect(json.batches).toEqual([{ repo: "owner/repo", skills: ["a"] }]);
  });

  test("rejects a second target positional", async () => {
    await expect(
      runDeploy(sb.env, opts({ args: [target, "/other/proj"], families: ["demo"], dryRun: true })),
    ).rejects.toThrow(UsageError);
  });

  test("a whitespace-only --agents is a usage error", async () => {
    await expect(
      runDeploy(sb.env, opts({ args: [target], families: ["demo"], agentsList: "   ", dryRun: true })),
    ).rejects.toThrow(/No agents configured/);
  });

  test("an explicit empty --agents is a usage error, not a fallback to defaults", async () => {
    await expect(
      runDeploy(sb.env, opts({ args: [target], families: ["demo"], agentsList: "", dryRun: true })),
    ).rejects.toThrow(/No agents configured/);
  });

  test("an option-like agent token is rejected, never forwarded to the skills CLI", async () => {
    // `--agents "codex -s foo"` must not smuggle `-s foo` into the child argv.
    await expect(
      runDeploy(sb.env, opts({ args: [target], families: ["demo"], agentsList: "codex -s foo", dryRun: true })),
    ).rejects.toThrow(/Invalid agent name: -s/);
  });
});
