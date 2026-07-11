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

describe("agent-definition field validation", () => {
  test("the real registry's agentDef fields validate", () => {
    const reg = realRegistry();
    expect(reg.agents["claude-code"]!.agentDefDir).toBe("~/.claude/agents");
    expect(reg.agents.codex!.agentDefDialect).toBe("codex");
    expect(reg.agents.pi!.agentDefSupport).toBe("none");
    expect(reg.agents.grok!.agentDefSupport).toBe("unknown");
  });

  test("a supported agentDef requires agentDefDir", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefSupport = "supported";
    reg.agents.alpha!.agentDefDialect = "claude";
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/requires agentDefDir/);
  });

  test("a supported agentDef requires agentDefDialect", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/requires agentDefDialect/);
  });

  test("a declared dir/dialect requires evidence", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefDialect = "claude";
    expect(() => validateRegistry(reg)).toThrow(/require agentDefEvidence/);
  });

  test("none support must not declare a dir", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefSupport = "none";
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/must not declare agentDefDir/);
  });

  test("rejects an invalid dialect", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefDialect = "toml" as never;
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/invalid agentDefDialect/);
  });

  test("rejects a non-string or empty agentDefDir", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefDir = 42 as never;
    reg.agents.alpha!.agentDefDialect = "claude";
    reg.agents.alpha!.agentDefEvidence = "test";
    expect(() => validateRegistry(reg)).toThrow(/agentDefDir must be a non-empty string/);
    reg.agents.alpha!.agentDefDir = "  ";
    expect(() => validateRegistry(reg)).toThrow(/agentDefDir must be a non-empty string/);
  });

  test("rejects a non-string or empty agentDefEvidence", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefDir = "~/.alpha/agents";
    reg.agents.alpha!.agentDefDialect = "claude";
    reg.agents.alpha!.agentDefEvidence = true as never;
    expect(() => validateRegistry(reg)).toThrow(/require agentDefEvidence/);
    reg.agents.alpha!.agentDefEvidence = "";
    expect(() => validateRegistry(reg)).toThrow(/require agentDefEvidence/);
  });

  test("an agent with no agentDef fields is fine", () => {
    expect(() => validateRegistry(baseRegistry())).not.toThrow();
  });

  test("rejects a stray agentDefEvidence with no support/dir/dialect", () => {
    const reg = baseRegistry();
    reg.agents.alpha!.agentDefEvidence = "orphan citation";
    expect(() => validateRegistry(reg)).toThrow(/requires agentDefDir/);
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
