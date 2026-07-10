import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { deepMerge, hashContent, renderSkill } from "../src/render";
import type { DesiredSkill } from "../src/types";
import { makeRoot, makeSandbox, makeSkill } from "./util";

/** Wrap a skill dir + optional claude override into a DesiredSkill for rendering. */
function desiredFrom(skillDir: string): DesiredSkill {
  const claude = path.join(skillDir, "agents", "claude.yaml");
  return {
    name: path.basename(skillDir),
    source: { root: "public", visibility: "public", path: skillDir },
    overrides: fs.existsSync(claude) ? { claude } : {},
  };
}

describe("deepMerge", () => {
  test("override wins on scalars, replaces arrays, recurses into objects", () => {
    const merged = deepMerge(
      { a: { x: 1, y: 2 }, arr: [1, 2], keep: "yes" },
      { a: { y: 3 }, arr: [9] },
    );
    expect(merged).toEqual({ a: { x: 1, y: 3 }, arr: [9], keep: "yes" });
  });
});

describe("hashContent", () => {
  test("matches the known sha256 of 'hello'", () => {
    expect(hashContent("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("renderSkill", () => {
  test("deep-merges override into frontmatter with canonical key order", () => {
    const sandbox = makeSandbox();
    try {
      const root = makeRoot(sandbox, "public");
      const dir = makeSkill(root.path, "drive", {
        frontmatter: { model: "sonnet", metadata: { a: 1 } },
        agentsYaml: { claude: { model: "opus", "allowed-tools": ["Bash"], metadata: { b: 2 } } },
      });
      const target = path.join(sandbox.base, "out", "drive");
      const result = renderSkill(sandbox.env, desiredFrom(dir), "claude", target);

      const rendered = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
      const fm = parseYaml(rendered.split("---")[1]!) as Record<string, unknown>;
      expect(fm.model).toBe("opus");
      expect(fm["allowed-tools"]).toEqual(["Bash"]);
      expect(fm.metadata).toEqual({ a: 1, b: 2 });

      // Canonical order: name, then description, before any dialect extras.
      const keys = Object.keys(fm);
      expect(keys[0]).toBe("name");
      expect(keys[1]).toBe("description");

      expect(result.hash).toBe(hashContent(rendered));
      expect(result.files).toContain("SKILL.md");
      expect(result.files).toContain(path.join("agents", "claude.yaml"));
    } finally {
      sandbox.cleanup();
    }
  });

  test("is deterministic — two renders produce identical bytes and hash", () => {
    const sandbox = makeSandbox();
    try {
      const root = makeRoot(sandbox, "public");
      const dir = makeSkill(root.path, "drive", {
        frontmatter: { model: "sonnet" },
        agentsYaml: { claude: { model: "opus", effort: "high" } },
      });
      const skill = desiredFrom(dir);
      const a = renderSkill(sandbox.env, skill, "claude", path.join(sandbox.base, "a", "drive"));
      const b = renderSkill(sandbox.env, skill, "claude", path.join(sandbox.base, "b", "drive"));
      expect(a.hash).toBe(b.hash);
      expect(fs.readFileSync(path.join(a.path, "SKILL.md"), "utf8")).toBe(
        fs.readFileSync(path.join(b.path, "SKILL.md"), "utf8"),
      );
    } finally {
      sandbox.cleanup();
    }
  });

  test("preserves the skill body byte-for-byte", () => {
    const sandbox = makeSandbox();
    try {
      const root = makeRoot(sandbox, "public");
      const body = "# Heading\n\nSome prose with a fence:\n\n```sh\necho hi --flag\n```\n";
      const dir = makeSkill(root.path, "drive", {
        body,
        agentsYaml: { claude: { model: "opus" } },
      });
      const target = path.join(sandbox.base, "out", "drive");
      renderSkill(sandbox.env, desiredFrom(dir), "claude", target);
      const rendered = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
      expect(rendered.endsWith(`${body}\n`)).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });
});
