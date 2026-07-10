import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadRegistry } from "../src/registry";
import { RootMissingError, hashDesiredState, resolveDesiredState } from "../src/resolve";
import type { MachineConfig, Registry } from "../src/types";
import {
  makeAgentScopes,
  makeOverlay,
  makeRoot,
  makeSandbox,
  makeSkill,
  realRegistryPath,
  type Sandbox,
} from "./util";

function reg(): Registry {
  return loadRegistry(realRegistryPath());
}

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

describe("resolveDesiredState — union + collisions", () => {
  test("unions skills across roots; a later root wins a name collision", () => {
    sandbox = makeSandbox();
    const pub = makeRoot(sandbox, "public", "public");
    const priv = makeRoot(sandbox, "private", "private");
    makeSkill(pub.path, "shared-name");
    makeSkill(pub.path, "only-public");
    makeSkill(priv.path, "shared-name");
    makeSkill(priv.path, "only-private");

    const config: MachineConfig = {
      version: 1,
      roots: [pub, priv],
      agents: ["claude-code", "codex"],
    };
    const desired = resolveDesiredState(sandbox.env, config, reg());

    const names = desired.skills.map((s) => s.name);
    expect(names).toEqual(["only-private", "only-public", "shared-name"]);

    const collided = desired.skills.find((s) => s.name === "shared-name")!;
    expect(collided.source.root).toBe("private"); // later root wins
    expect(collided.source.visibility).toBe("private");

    const collision = desired.warnings.find((w) => w.kind === "collision");
    expect(collision?.skill).toBe("shared-name");
    expect(collision?.message).toContain("'private' wins");
  });

  test("a dir without SKILL.md is not treated as a skill", () => {
    sandbox = makeSandbox();
    const pub = makeRoot(sandbox, "public", "public");
    makeSkill(pub.path, "real");
    fs.mkdirSync(path.join(pub.path, "skills", "not-a-skill"), { recursive: true });

    const config: MachineConfig = { version: 1, roots: [pub], agents: ["codex"] };
    const desired = resolveDesiredState(sandbox.env, config, reg());
    expect(desired.skills.map((s) => s.name)).toEqual(["real"]);
  });
});

describe("resolveDesiredState — scoping", () => {
  test("applies public catalog allow/deny and leaves absent skills unscoped", () => {
    sandbox = makeSandbox();
    const pub = makeRoot(sandbox, "public", "public");
    makeSkill(pub.path, "drive-codex");
    makeSkill(pub.path, "drive-claude");
    makeSkill(pub.path, "plain");
    makeAgentScopes(pub.path, {
      "drive-codex": { agents: { deny: ["codex"] } },
      "drive-claude": { agents: { allow: ["claude-code"] } },
    });

    const config: MachineConfig = { version: 1, roots: [pub], agents: ["claude-code", "codex"] };
    const desired = resolveDesiredState(sandbox.env, config, reg());
    const byName = Object.fromEntries(desired.skills.map((s) => [s.name, s]));

    // deny preserved as deny (the solver expands it against the read graph).
    expect(byName["drive-codex"]!.scoping).toEqual({ deny: ["codex"] });
    // allow preserved as allow.
    expect(byName["drive-claude"]!.scoping).toEqual({ allow: ["claude-code"] });
    // absent from the map => unscoped.
    expect(byName.plain!.scoping).toBeUndefined();
  });

  test("private roots scope via overlay.json, not the catalog", () => {
    sandbox = makeSandbox();
    const priv = makeRoot(sandbox, "private", "private");
    makeSkill(priv.path, "fleet-ops");
    makeOverlay(priv.path, {
      name: "auro-private",
      skills: { "fleet-ops": { agents: { allow: ["claude-code", "codex"] } } },
    });

    const config: MachineConfig = { version: 1, roots: [priv], agents: ["claude-code", "codex"] };
    const desired = resolveDesiredState(sandbox.env, config, reg());
    expect(desired.skills[0]!.scoping).toEqual({ allow: ["claude-code", "codex"] });
  });

  test("an unknown agent id in a catalog scope aborts resolution", () => {
    sandbox = makeSandbox();
    const pub = makeRoot(sandbox, "public", "public");
    makeSkill(pub.path, "s");
    makeAgentScopes(pub.path, { s: { agents: { allow: ["nobody"] } } });
    const config: MachineConfig = { version: 1, roots: [pub], agents: ["codex"] };
    expect(() => resolveDesiredState(sandbox!.env, config, reg())).toThrow(/unknown agent 'nobody'/);
  });
});

describe("resolveDesiredState — overrides + frontmatter", () => {
  test("advertises agents/*.yaml override presence", () => {
    sandbox = makeSandbox();
    const pub = makeRoot(sandbox, "public", "public");
    makeSkill(pub.path, "rich", {
      agentsYaml: {
        claude: { model: "opus" },
        openai: { interface: { display: "Rich" } },
      },
    });
    const config: MachineConfig = { version: 1, roots: [pub], agents: ["claude-code"] };
    const desired = resolveDesiredState(sandbox.env, config, reg());
    const overrides = desired.skills[0]!.overrides;
    expect(overrides.claude).toContain("agents/claude.yaml");
    expect(overrides.openai).toContain("agents/openai.yaml");
    expect(overrides.copilot).toBeUndefined();
    expect(overrides.codex).toBeUndefined();
  });

  test("warns (non-fatal) when frontmatter lacks name/description", () => {
    sandbox = makeSandbox();
    const pub = makeRoot(sandbox, "public", "public");
    const dir = path.join(pub.path, "skills", "thin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: thin\n---\n\nbody\n");

    const config: MachineConfig = { version: 1, roots: [pub], agents: ["codex"] };
    const desired = resolveDesiredState(sandbox.env, config, reg());
    expect(desired.skills.map((s) => s.name)).toEqual(["thin"]); // still resolved
    const warn = desired.warnings.find((w) => w.skill === "thin");
    expect(warn?.message).toContain("description");
  });
});

describe("resolveDesiredState — missing root", () => {
  test("throws RootMissingError when a registered root is absent", () => {
    sandbox = makeSandbox();
    const config: MachineConfig = {
      version: 1,
      roots: [{ name: "gone", path: path.join(sandbox.base, "nope"), visibility: "private" }],
      agents: ["codex"],
    };
    expect(() => resolveDesiredState(sandbox!.env, config, reg())).toThrow(RootMissingError);
  });
});

describe("hashDesiredState", () => {
  test("is stable across reorderings and shifts when scoping changes", () => {
    sandbox = makeSandbox();
    const pub = makeRoot(sandbox, "public", "public");
    makeSkill(pub.path, "a");
    makeSkill(pub.path, "b");
    const config: MachineConfig = { version: 1, roots: [pub], agents: ["codex"] };

    const first = resolveDesiredState(sandbox.env, config, reg());
    const again = resolveDesiredState(sandbox.env, config, reg());
    expect(again.hash).toBe(first.hash);
    // hash is order-independent over the skill set.
    expect(hashDesiredState([...first.skills].reverse())).toBe(first.hash);

    makeAgentScopes(pub.path, { a: { agents: { deny: ["codex"] } } });
    const scoped = resolveDesiredState(sandbox.env, config, reg());
    expect(scoped.hash).not.toBe(first.hash);
  });
});
