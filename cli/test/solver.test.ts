import { describe, expect, test } from "bun:test";
import { loadRegistry } from "../src/registry";
import { bleedFor, solvePlacements } from "../src/solver";
import type { AgentScope, DesiredSkill, MachineConfig, Registry } from "../src/types";
import { realRegistryPath } from "./util";

function reg(): Registry {
  return loadRegistry(realRegistryPath());
}

/** Build a DesiredSkill (the solver never touches the fs, so paths are inert). */
function desired(
  name: string,
  opts: { scoping?: AgentScope; overrides?: DesiredSkill["overrides"] } = {},
): DesiredSkill {
  return {
    name,
    source: { root: "public", visibility: "public", path: "/dummy" },
    scoping: opts.scoping,
    overrides: opts.overrides ?? {},
  };
}

const defaultConfig: MachineConfig = { version: 1, roots: [] };

describe("solvePlacements — unscoped", () => {
  test("places into shared + claude, both symlinks, no hermes by default", () => {
    const r = solvePlacements(desired("alpha"), defaultConfig, reg());
    const dirs = r.placements.map((p) => p.dir).sort();
    expect(dirs).toEqual(["claude", "shared"]);
    expect(r.placements.every((p) => p.kind === "symlink")).toBe(true);
    expect(r.unreachable).toEqual([]);
  });

  test("hermes gets an add-only placement only when enabled", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code", "hermes"] };
    const r = solvePlacements(desired("alpha"), config, reg());
    const hermes = r.placements.find((p) => p.dir === "hermes");
    expect(hermes).toBeDefined();
    expect(hermes!.agent).toBe("hermes");
    expect(hermes!.addOnly).toBe(true);
  });

  test("a claude.yaml override renders the claude placement", () => {
    const r = solvePlacements(
      desired("alpha", { overrides: { claude: "/x/agents/claude.yaml" } }),
      defaultConfig,
      reg(),
    );
    const claude = r.placements.find((p) => p.dir === "claude");
    expect(claude!.kind).toBe("rendered");
  });
});

describe("solvePlacements — allow", () => {
  test("allow claude-code lands in the claude dir with opencode+cursor bleed", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { allow: ["claude-code"] } }),
      defaultConfig,
      reg(),
    );
    expect(r.placements.map((p) => p.dir)).toEqual(["claude"]);
    const p = r.placements[0]!;
    expect(p.agent).toBe("claude-code");
    expect(p.kind).toBe("symlink");
    expect(p.bleed).toEqual(["cursor", "opencode"]);
    // Scoped skills never touch the shared dir.
    expect(r.placements.some((x) => x.dir === "shared")).toBe(false);
  });

  test("allow claude-code with a claude override renders", () => {
    const r = solvePlacements(
      desired("drive", {
        scoping: { allow: ["claude-code"] },
        overrides: { claude: "/x/agents/claude.yaml" },
      }),
      defaultConfig,
      reg(),
    );
    expect(r.placements[0]!.kind).toBe("rendered");
  });

  test("allow codex uses the deprecated codex dir and reports cursor bleed", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { allow: ["codex"] } }),
      defaultConfig,
      reg(),
    );
    const p = r.placements[0]!;
    expect(p.dir).toBe("codex");
    expect(p.deprecated).toBe(true);
    expect(p.bleed).toEqual(["cursor"]);
  });

  test("allow aider is unreachable (no readable dir), no placements", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { allow: ["aider"] } }),
      defaultConfig,
      reg(),
    );
    expect(r.placements).toEqual([]);
    expect(r.unreachable).toEqual(["aider"]);
  });
});

describe("solvePlacements — deny (hard guarantee incl. maybeReads)", () => {
  test("deny grok forbids grok's maybe-reads (shared + claude); claude-code unreachable", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { deny: ["grok"] } }),
      defaultConfig,
      reg(),
    );
    const forbidden = new Set(["grok", "shared", "claude"]);
    for (const p of r.placements) expect(forbidden.has(p.dir)).toBe(false);
    expect(r.unreachable).toContain("claude-code");
  });

  test("deny antigravity forbids its maybe-read of the gemini dir; gemini-cli unreachable", () => {
    const r = solvePlacements(
      desired("drive", { scoping: { deny: ["antigravity"] } }),
      defaultConfig,
      reg(),
    );
    for (const p of r.placements) {
      expect(p.dir).not.toBe("gemini");
      expect(p.dir).not.toBe("antigravity");
    }
    expect(r.unreachable).toContain("gemini-cli");
  });

  test("a deny that empties an agent's only dir reports it unreachable", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["claude-code"] };
    const r = solvePlacements(
      desired("drive", { scoping: { deny: ["opencode"] } }),
      config,
      reg(),
    );
    // opencode reads the claude dir, so denying it forbids claude-code's only target.
    expect(r.placements).toEqual([]);
    expect(r.unreachable).toEqual(["claude-code"]);
  });
});

describe("bleedFor", () => {
  test("claude dir bleeds to opencode and cursor (hard reads only, not grok's maybe)", () => {
    const placement = { agent: "claude-code", dir: "claude", path: "/x", kind: "symlink" as const };
    expect(bleedFor(reg(), placement, ["claude-code"])).toEqual(["cursor", "opencode"]);
  });
});
