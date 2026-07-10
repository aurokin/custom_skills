import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  loadScopingSource,
  preservedNames,
  publicScopingPath,
  scopingForSkill,
  validateScopingSource,
} from "../src/catalog";
import { loadRegistry } from "../src/registry";
import type { Registry } from "../src/types";
import {
  makeAgentScopes,
  makeRoot,
  makeSandbox,
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

describe("publicScopingPath", () => {
  test("points at <root>/catalog/agent-scopes.json", () => {
    expect(publicScopingPath("/x/repo")).toBe("/x/repo/catalog/agent-scopes.json");
  });
});

describe("loadScopingSource", () => {
  test("parses allow and deny scopes into a normalized source", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    makeAgentScopes(root.path, {
      "drive-codex": { agents: { deny: ["codex"] } },
      "drive-claude": { agents: { allow: ["claude-code"] } },
      unscoped: {},
    });
    const src = loadScopingSource(publicScopingPath(root.path), reg());
    expect(src.version).toBe(1);
    expect(src.skills["drive-codex"]!.agents).toEqual({ deny: ["codex"] });
    expect(src.skills["drive-claude"]!.agents).toEqual({ allow: ["claude-code"] });
    expect(src.skills.unscoped!.agents).toBeUndefined();
  });

  test("rejects a skill that sets both allow and deny", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    makeAgentScopes(root.path, {
      bad: { agents: { allow: ["codex"], deny: ["claude-code"] } },
    });
    expect(() => loadScopingSource(publicScopingPath(root.path), reg())).toThrow(
      /exactly one of 'allow' or 'deny'/,
    );
  });

  test("rejects a skill that sets neither allow nor deny", () => {
    const label = "scopes";
    expect(() => validateScopingSource({ version: 1, skills: { s: { agents: {} } } }, label)).toThrow(
      /exactly one of 'allow' or 'deny'/,
    );
  });

  test("rejects an unknown agent id when a registry is supplied", () => {
    expect(() =>
      validateScopingSource({ version: 1, skills: { s: { agents: { allow: ["nobody"] } } } }, "s", reg()),
    ).toThrow(/unknown agent 'nobody'/);
  });

  test("accepts an unknown agent id when no registry is supplied (shape-only)", () => {
    expect(() =>
      validateScopingSource({ version: 1, skills: { s: { agents: { allow: ["nobody"] } } } }, "s"),
    ).not.toThrow();
  });

  test("rejects a missing numeric version", () => {
    expect(() => validateScopingSource({ skills: {} }, "s")).toThrow(/numeric 'version'/);
  });

  test("rejects a non-string entry in allow", () => {
    expect(() =>
      validateScopingSource({ version: 1, skills: { s: { agents: { allow: [1] } } } }, "s"),
    ).toThrow(/array of non-empty strings/);
  });
});

describe("scopingForSkill", () => {
  test("returns the scope for a named skill and undefined otherwise", () => {
    const src = validateScopingSource(
      { version: 1, skills: { s: { agents: { deny: ["codex"] } } } },
      "s",
    );
    expect(scopingForSkill(src, "s")).toEqual({ deny: ["codex"] });
    expect(scopingForSkill(src, "missing")).toBeUndefined();
    expect(scopingForSkill(undefined, "s")).toBeUndefined();
  });
});

describe("preservedNames", () => {
  test("reads preserveGlobalSkillNames from a public root", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    fs.writeFileSync(
      path.join(root.path, ".skills.local.json"),
      JSON.stringify({ preserveGlobalSkillNames: ["handmade-a", "handmade-b"] }),
    );
    expect(preservedNames(root)).toEqual(["handmade-a", "handmade-b"]);
  });

  test("returns [] for a missing file", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    expect(preservedNames(root)).toEqual([]);
  });

  test("returns [] for a non-public root without reading the file", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    fs.writeFileSync(
      path.join(root.path, ".skills.local.json"),
      JSON.stringify({ preserveGlobalSkillNames: ["x"] }),
    );
    expect(preservedNames(root)).toEqual([]);
  });

  test("rejects a name containing '/' or '@'", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "public", "public");
    fs.writeFileSync(
      path.join(root.path, ".skills.local.json"),
      JSON.stringify({ preserveGlobalSkillNames: ["owner/repo@skill"] }),
    );
    expect(() => preservedNames(root)).toThrow(/without whitespace/);
  });
});
