import { describe, expect, test } from "bun:test";
import {
  defaultEnabledAgents,
  dirPath,
  enabledAgents,
  loadRegistry,
  readersOf,
  validateRegistry,
} from "../src/registry";
import type { AgentCapability, MachineConfig, Registry } from "../src/types";
import { makeSandbox, realRegistryPath } from "./util";

/** The real, authoritative registry (read-only load). */
function realRegistry(): Registry {
  return loadRegistry(realRegistryPath());
}

/** A minimal valid registry for negative-case surgery. */
function baseRegistry(): Registry {
  const agent = (over: Partial<AgentCapability>): AgentCapability => ({
    skillsSupport: "supported",
    reads: [],
    maybeReads: [],
    ownDir: "shared",
    dialect: "spec",
    symlinks: "followed",
    evidence: "test",
    ...over,
  });
  return {
    version: 1,
    directories: {
      shared: { path: "~/.agents/skills" },
      claude: { path: "~/.claude/skills" },
    },
    agents: {
      alpha: agent({ reads: ["shared"], ownDir: "shared" }),
      claudey: agent({ reads: ["claude"], ownDir: "claude" }),
    },
  };
}

describe("loadRegistry + validateRegistry", () => {
  test("the real registry loads and validates", () => {
    const reg = realRegistry();
    expect(reg.version).toBe(1);
    expect(Object.keys(reg.agents).length).toBeGreaterThan(5);
  });

  test("a hand-built valid registry passes", () => {
    expect(() => validateRegistry(baseRegistry())).not.toThrow();
  });

  test("rejects reads referencing an unknown directory", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.reads = ["nope"];
    expect(() => validateRegistry(reg)).toThrow(/unknown directory 'nope'/);
  });

  test("rejects maybeReads referencing an unknown directory", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.maybeReads = ["ghost"];
    expect(() => validateRegistry(reg)).toThrow(/maybeReads unknown directory 'ghost'/);
  });

  test("rejects an ownDir not in directories", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.ownDir = "missing";
    expect(() => validateRegistry(reg)).toThrow(/ownDir 'missing'/);
  });

  test("rejects a supported agent with no ownDir", () => {
    const reg = baseRegistry();
    delete reg.agents.alpha!.ownDir;
    expect(() => validateRegistry(reg)).toThrow(/has no ownDir/);
  });
});

describe("readersOf", () => {
  const reg = realRegistry();

  test("shared dir is read by codex and droid but not claude-code", () => {
    const readers = readersOf(reg, "shared");
    expect(readers).toContain("codex");
    expect(readers).toContain("droid");
    expect(readers).not.toContain("claude-code");
  });

  test("claude dir bleeds to opencode and cursor", () => {
    const readers = readersOf(reg, "claude");
    expect(readers).toContain("claude-code");
    expect(readers).toContain("opencode");
    expect(readers).toContain("cursor");
  });

  test("includeMaybe pulls in grok's unconfirmed shared read", () => {
    expect(readersOf(reg, "shared")).not.toContain("grok");
    expect(readersOf(reg, "shared", { includeMaybe: true })).toContain("grok");
  });
});

describe("enabledAgents / defaultEnabledAgents", () => {
  const reg = realRegistry();

  test("default set excludes hermes (opt-in) and aider (unsupported)", () => {
    const def = defaultEnabledAgents(reg);
    expect(def).toContain("claude-code");
    expect(def).toContain("codex");
    expect(def).not.toContain("hermes");
    expect(def).not.toContain("aider");
  });

  test("explicit config.agents is honored verbatim", () => {
    const config: MachineConfig = { version: 1, roots: [], agents: ["codex", "hermes"] };
    expect(enabledAgents(config, reg)).toEqual(["codex", "hermes"]);
  });

  test("absent config.agents falls back to the default set", () => {
    const config: MachineConfig = { version: 1, roots: [] };
    expect(enabledAgents(config, reg)).toEqual(defaultEnabledAgents(reg));
  });
});

describe("dirPath", () => {
  test("expands ~ against the injected home", () => {
    const sandbox = makeSandbox();
    try {
      const reg = realRegistry();
      expect(dirPath(sandbox.env, reg, "claude")).toBe(`${sandbox.home}/.claude/skills`);
    } finally {
      sandbox.cleanup();
    }
  });

  test("throws on an unknown directory id", () => {
    const sandbox = makeSandbox();
    try {
      expect(() => dirPath(sandbox.env, realRegistry(), "nope")).toThrow(/unknown directory/);
    } finally {
      sandbox.cleanup();
    }
  });
});
