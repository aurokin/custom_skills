// Parity port of custom_agents/tests/test_schema.py against the TypeScript
// schema in src/agentdef/schema.ts. Each `test_schema_*` oracle case is mirrored
// here; the accept/reject decisions must match the Python oracle exactly.
//
// The oracle reads {agent.yaml, instructions.md} from disk; our port validates an
// already-parsed mapping plus the raw instructions body, so tests parse the YAML
// with the same `yaml` library the CLI uses and pass a non-empty body.

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { loadAgentDefinition, normalizeSkillName, SchemaError } from "../src/agentdef/schema";

function load(agentYaml: string, instructions = "Be useful.\n") {
  return loadAgentDefinition({ agentYaml: parse(agentYaml), instructionsMd: instructions });
}

function expectReject(agentYaml: string, re: RegExp, instructions = "Be useful.\n") {
  expect(() => load(agentYaml, instructions)).toThrow(re);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (mirror tests/fixtures/*)
// ─────────────────────────────────────────────────────────────────────────────

const MINIMAL_AGENT = [
  "name: code-reviewer",
  "description: Reviews code for correctness and risk.",
].join("\n");

const FULL_AGENT = `
name: frontend-reviewer
description: Reviews frontend code, UX regressions, and performance.
defaults:
  sandbox: workspace-write
  skills:
    - web-design-guidelines
    - plan-reviewer
claude:
  model: opus-4.6
  tools:
    - Read
    - Grep
    - Glob
  disallowed_tools:
    - Write
  permission_mode: default
  max_turns: 12
  effort: high
  mcp_servers:
    - github
  background: true
copilot:
  target: github-copilot
  tools:
    - read
    - search
    - edit
    - github/*
  model: gpt-5.4-high
  disable_model_invocation: true
  user_invocable: true
  metadata:
    owner: frontend-platform
    tier: primary
codex:
  model: gpt-5.4
  model_reasoning_effort: high
  nickname_candidates:
    - Atlas
    - Echo
  mcp_servers:
    github:
      command: npx
      args:
        - -y
        - "@modelcontextprotocol/server-github"
  skills_config:
    - name: web-design-guidelines
      enabled: false
cursor:
  model: gpt-5.4-cursor
  readonly: false
  description: Cursor-specific frontend reviewer blurb
opencode:
  model: opencode/gpt-5.1-codex
  variant: reasoning
  temperature: 0.1
  top_p: 0.9
  disable: true
  mode: subagent
  hidden: true
  color: accent
  steps: 8
  description: OpenCode-specific frontend reviewer blurb
  permission:
    edit: ask
    bash:
      "*": ask
      "git diff*": allow
  options:
    reasoningEffort: high
gemini:
  tools:
    - read_file
    - grep_search
    - mcp_github_*
  model: gemini-2.5-flash
  temperature: 0.2
  max_turns: 12
  timeout_mins: 10
  mcp_servers:
    github:
      command: npx
      args:
        - -y
        - "@modelcontextprotocol/server-github"
`;

const TPROMPT_AGENT = [
  "name: skill-reviewer",
  "description: Acts like a skill that reviews changes in the main thread.",
  "tprompt:",
  "  title: Skill Reviewer",
  "  tags:",
  "    - review",
  "    - skill",
  "  key: r",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// Defaults / model strategy
// ─────────────────────────────────────────────────────────────────────────────

describe("defaults + model strategy", () => {
  test("minimal agent resolves defaults", () => {
    const agent = load(MINIMAL_AGENT);
    expect(agent.name).toBe("code-reviewer");
    expect(agent.description).toBe("Reviews code for correctness and risk.");
    expect(agent.sandbox).toBe("read-only");
    expect(agent.modelStrategy).toBe("pinned-defaults");
    expect(agent.shouldEmitModelDefaults()).toBe(true);
    expect(agent.skills).toEqual([]);
    expect(agent.claude.model).toBeUndefined();
    expect(agent.claude.effort).toBeUndefined();
    expect(agent.resolvedClaudeModel()).toBe("opus-4.7");
    expect(agent.resolvedClaudeEffort()).toBe("high");
    expect(agent.codex.model).toBeUndefined();
    expect(agent.codex.modelReasoningEffort).toBeUndefined();
    expect(agent.resolvedCodexModel()).toBe("gpt-5.5");
    expect(agent.resolvedCodexReasoningEffort()).toBe("high");
    expect(agent.codex.sandboxMode).toBeUndefined();
    expect(agent.copilot.model).toBeUndefined();
    expect(agent.resolvedCopilotModel()).toBe("gpt-5.5-high");
    expect(agent.gemini.model).toBeUndefined();
  });

  test("explicit floating model_strategy", () => {
    const agent = load(
      ["name: floating-reviewer", "description: Uses downstream model defaults", "defaults:", "  model_strategy: floating"].join("\n"),
    );
    expect(agent.modelStrategy).toBe("floating");
    expect(agent.shouldEmitModelDefaults()).toBe(false);
  });

  test("rejects invalid model_strategy", () => {
    expectReject(
      ["name: invalid-model-strategy", "description: Invalid model strategy", "defaults:", "  model_strategy: drift"].join("\n"),
      /Invalid defaults.model_strategy/,
    );
  });

  test("rejects unknown defaults keys", () => {
    expectReject(
      ["name: unknown-defaults", "description: Unknown defaults key", "defaults:", "  sandbox: read-only", "  model_mode: floating"].join("\n"),
      /Unknown defaults keys/,
    );
  });

  test("resolvedCodexSandboxMode maps full-access", () => {
    const agent = load([...MINIMAL_AGENT.split("\n"), "defaults:", "  sandbox: full-access"].join("\n"));
    expect(agent.resolvedCodexSandboxMode()).toBe("danger-full-access");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gemini
// ─────────────────────────────────────────────────────────────────────────────

describe("gemini", () => {
  test("rejects unknown gemini keys", () => {
    expectReject(["name: bad-gemini", "description: Invalid gemini config", "gemini:", "  unsupported: true"].join("\n"), /Unknown gemini keys/);
  });

  test("rejects invalid gemini temperature", () => {
    expectReject(["name: invalid-gemini-temperature", "description: Invalid gemini temperature", "gemini:", "  temperature: 3"].join("\n"), /Invalid gemini.temperature/);
  });

  test("rejects non-positive gemini max_turns", () => {
    expectReject(["name: bad-turns", "description: Bad turns", "gemini:", "  max_turns: 0"].join("\n"), /Invalid gemini.max_turns/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full agent
// ─────────────────────────────────────────────────────────────────────────────

describe("full agent", () => {
  const agent = load(FULL_AGENT, "You are a frontend review specialist.\n");

  test("parses every block", () => {
    expect(agent.sandbox).toBe("workspace-write");
    expect(agent.skills).toEqual(["web-design-guidelines", "plan-reviewer"]);
    expect(agent.claude.model).toBe("opus-4.6");
    expect(agent.claude.extra).toEqual({ background: true });
    expect(agent.copilot.target).toBe("github-copilot");
    expect(agent.copilot.tools).toEqual(["read", "search", "edit", "github/*"]);
    expect(agent.copilot.model).toBe("gpt-5.4-high");
    expect(agent.copilot.disableModelInvocation).toBe(true);
    expect(agent.copilot.userInvocable).toBe(true);
    expect(agent.copilot.metadata).toEqual({ owner: "frontend-platform", tier: "primary" });
    expect(agent.codex.model).toBe("gpt-5.4");
    expect(agent.codex.modelReasoningEffort).toBe("high");
    expect(agent.codex.nicknameCandidates).toEqual(["Atlas", "Echo"]);
    expect(agent.codex.skillsConfig).toEqual([{ name: "web-design-guidelines", enabled: false }]);
    expect(agent.gemini.tools).toEqual(["read_file", "grep_search", "mcp_github_*"]);
    expect(agent.gemini.model).toBe("gemini-2.5-flash");
    expect(agent.gemini.temperature).toBe(0.2);
    expect(agent.gemini.maxTurns).toBe(12);
    expect(agent.gemini.timeoutMins).toBe(10);
    expect(agent.gemini.mcpServers).toEqual({
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    });
  });

  test("cursor + opencode blocks parse", () => {
    expect(agent.cursor.model).toBe("gpt-5.4-cursor");
    expect(agent.cursor.readonly).toBe(false);
    expect(agent.cursor.description).toBe("Cursor-specific frontend reviewer blurb");
    expect(agent.resolvedCursorReadonly()).toBe(false);
    expect(agent.opencode.model).toBe("opencode/gpt-5.1-codex");
    expect(agent.opencode.variant).toBe("reasoning");
    expect(agent.opencode.temperature).toBe(0.1);
    expect(agent.opencode.topP).toBe(0.9);
    expect(agent.opencode.disable).toBe(true);
    expect(agent.opencode.mode).toBe("subagent");
    expect(agent.opencode.hidden).toBe(true);
    expect(agent.opencode.color).toBe("accent");
    expect(agent.opencode.steps).toBe(8);
    expect(agent.opencode.description).toBe("OpenCode-specific frontend reviewer blurb");
    expect(agent.opencode.permission).toEqual({ edit: "ask", bash: { "*": "ask", "git diff*": "allow" } });
    expect(agent.opencode.options).toEqual({ reasoningEffort: "high" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Required fields / instructions
// ─────────────────────────────────────────────────────────────────────────────

describe("required fields", () => {
  test("missing name", () => {
    expectReject("description: Missing the required name\n", /Missing required field 'name'/);
  });

  test("empty instructions rejected", () => {
    expect(() => load("name: r\ndescription: has body\n", "   \n")).toThrow(/instructions.md is empty/);
  });

  test("invalid name", () => {
    expectReject("name: 'Bad Name'\ndescription: bad\n", /Invalid name/);
  });

  test("allows underscore agent name", () => {
    const agent = load(
      ["name: retrorabbit_code_reviewer", "description: Reviews hunks for correctness", "codex:", "  nickname_candidates:", "    - RetroRabbit"].join("\n"),
    );
    expect(agent.name).toBe("retrorabbit_code_reviewer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude / codex / copilot passthrough
// ─────────────────────────────────────────────────────────────────────────────

describe("passthrough + unknown keys", () => {
  test("unknown claude keys preserved in extra", () => {
    const agent = load(["name: reviewer", "description: Keeps extra Claude frontmatter", "claude:", "  memory: user", "  background: true"].join("\n"));
    expect(agent.claude.extra).toEqual({ memory: "user", background: true });
  });

  test("unknown codex keys fail", () => {
    expectReject(["name: reviewer", "description: Invalid codex passthrough", "codex:", "  unsupported: true"].join("\n"), /Unknown codex keys/);
  });

  test("codex.config with reserved key fails", () => {
    expectReject(["name: r", "description: d", "codex:", "  config:", "    model: gpt"].join("\n"), /handled elsewhere/);
  });

  test("unknown copilot keys fail", () => {
    expectReject(["name: reviewer", "description: Invalid copilot config", "copilot:", "  unsupported: true"].join("\n"), /Unknown copilot keys/);
  });

  test("rejects invalid claude effort", () => {
    expectReject(["name: r", "description: d", "claude:", "  effort: extreme"].join("\n"), /Invalid claude.effort/);
  });

  test("rejects duplicate nickname candidates", () => {
    expectReject(["name: r", "description: d", "codex:", "  nickname_candidates:", "    - Atlas", "    - atlas"].join("\n"), /Duplicate codex.nickname_candidates/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Copilot targets
// ─────────────────────────────────────────────────────────────────────────────

describe("copilot target gating", () => {
  test("vscode supports model list + mcp server list + handoffs", () => {
    const agent = load(
      [
        "name: vscode-reviewer",
        "description: VS Code Copilot agent",
        "copilot:",
        "  target: vscode",
        "  agents: '*'",
        "  model:",
        "    - gpt-5.4-high",
        "    - gpt-5.4",
        "  mcp_servers:",
        "    - id: github",
        "      command:",
        "        name: npx",
        "        args:",
        "          - -y",
        "          - github-mcp",
        "  argument_hint: repo:path",
        "  disable_model_invocation: true",
        "  user_invocable: true",
        "  handoffs:",
        "    - label: Code Review",
        "      agent: code-review",
        "      send: true",
        "      model:",
        "        - gpt-5.4-high",
        "        - gpt-5.4",
        "  hooks:",
        "    post-edit:",
        "      command: npm test",
      ].join("\n"),
    );
    expect(agent.copilot.target).toBe("vscode");
    expect(agent.copilot.agents).toBe("*");
    expect(agent.copilot.model).toEqual(["gpt-5.4-high", "gpt-5.4"]);
    expect(agent.copilot.mcpServers).toEqual([{ id: "github", command: { name: "npx", args: ["-y", "github-mcp"] } }]);
    expect(agent.copilot.argumentHint).toBe("repo:path");
    expect(agent.copilot.disableModelInvocation).toBe(true);
    expect(agent.copilot.userInvocable).toBe(true);
    expect(agent.copilot.handoffs).toEqual([{ label: "Code Review", agent: "code-review", send: true, model: ["gpt-5.4-high", "gpt-5.4"] }]);
    expect(agent.copilot.hooks).toEqual({ "post-edit": { command: "npm test" } });
  });

  test("vscode rejects github-only metadata", () => {
    expectReject(
      ["name: vscode-invalid", "description: Invalid VS Code config", "copilot:", "  target: vscode", "  metadata:", "    team: editor"].join("\n"),
      /only supported for target 'github-copilot'/,
    );
  });

  test("model list requires vscode target", () => {
    expectReject(
      ["name: ambiguous-copilot", "description: Missing explicit target", "copilot:", "  model:", "    - gpt-5.4-high", "    - gpt-5.4"].join("\n"),
      /Set copilot.target to 'vscode'/,
    );
  });

  test("github target rejects a model list", () => {
    expectReject(
      ["name: gh", "description: d", "copilot:", "  target: github-copilot", "  model:", "    - a", "    - b"].join("\n"),
      /copilot.model must be a string/,
    );
  });

  test("no-target rejects agents/hooks", () => {
    expectReject(["name: gh", "description: d", "copilot:", "  agents: '*'"].join("\n"), /Set copilot.target to 'vscode'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cursor
// ─────────────────────────────────────────────────────────────────────────────

describe("cursor", () => {
  test("readonly derives from read-only sandbox", () => {
    const agent = load(MINIMAL_AGENT);
    expect(agent.cursor.model).toBeUndefined();
    expect(agent.cursor.readonly).toBeUndefined();
    expect(agent.cursor.description).toBeUndefined();
    expect(agent.resolvedCursorReadonly()).toBe(true);
  });

  test("readonly omitted for workspace-write", () => {
    const agent = load(["name: workspace-cursor", "description: Workspace-write agent", "defaults:", "  sandbox: workspace-write"].join("\n"));
    expect(agent.resolvedCursorReadonly()).toBeUndefined();
  });

  test("rejects unknown keys", () => {
    expectReject(["name: bad-cursor", "description: Invalid cursor config", "cursor:", "  scope: project"].join("\n"), /Unknown cursor keys/);
  });

  test("rejects non-bool readonly", () => {
    expectReject(["name: bad-cursor-readonly", "description: Invalid readonly type", "cursor:", "  readonly: yes-please"].join("\n"), /Expected 'readonly' to be a boolean/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode
// ─────────────────────────────────────────────────────────────────────────────

describe("opencode", () => {
  test("defaults to subagent + read-only permission", () => {
    const agent = load(MINIMAL_AGENT);
    expect(agent.opencode.model).toBeUndefined();
    expect(agent.opencode.mode).toBeUndefined();
    expect(agent.resolvedOpencodeMode()).toBe("subagent");
    expect(agent.resolvedOpencodePermission()).toEqual({ edit: "deny", bash: "deny" });
  });

  test("rejects unknown keys", () => {
    expectReject(["name: bad-opencode", "description: Invalid opencode config", "opencode:", "  unsupported: true"].join("\n"), /Unknown opencode keys/);
  });

  test("rejects invalid mode", () => {
    expectReject(["name: bad-opencode-mode", "description: Invalid opencode mode", "opencode:", "  mode: readonly"].join("\n"), /Invalid opencode.mode/);
  });

  test("rejects invalid tools (non-bool value)", () => {
    expectReject(["name: bad-opencode-tools", "description: Invalid opencode tools", "opencode:", "  tools:", "    edit: deny"].join("\n"), /Expected every 'tools' value to be a boolean/);
  });

  test("options reject reserved key: permission", () => {
    expectReject(["name: bad-opencode-options", "description: Invalid opencode options", "opencode:", "  options:", "    permission: {}"].join("\n"), /opencode.options.*permission/);
  });

  test("options reject reserved key: disable", () => {
    expectReject(["name: bad-opencode-options-disable", "description: Invalid", "opencode:", "  options:", "    disable: true"].join("\n"), /opencode.options.*disable/);
  });

  test("rejects invalid color", () => {
    expectReject(["name: bad-color", "description: d", "opencode:", "  color: chartreuse"].join("\n"), /Invalid opencode.color/);
  });

  test("accepts hex color", () => {
    const agent = load(["name: hexy", "description: d", "opencode:", "  color: '#ff00aa'"].join("\n"));
    expect(agent.opencode.color).toBe("#ff00aa");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tprompt
// ─────────────────────────────────────────────────────────────────────────────

describe("tprompt", () => {
  test("block enables export", () => {
    const agent = load(TPROMPT_AGENT, "Review the staged diff.\n");
    expect(agent.tprompt.enabled).toBe(true);
    expect(agent.tprompt.title).toBe("Skill Reviewer");
    expect(agent.tprompt.tags).toEqual(["review", "skill"]);
    expect(agent.tprompt.key).toBe("r");
    expect(agent.tprompt.description).toBeUndefined();
    expect(agent.tprompt.filename).toBeUndefined();
  });

  test("absent block disables export", () => {
    const agent = load(MINIMAL_AGENT);
    expect(agent.tprompt.enabled).toBe(false);
    expect(agent.tprompt.title).toBeUndefined();
  });

  test("empty block enables export", () => {
    const agent = load(["name: tprompt-empty", "description: Tprompt opt-in with defaults", "tprompt: {}"].join("\n"));
    expect(agent.tprompt.enabled).toBe(true);
    expect(agent.tprompt.title).toBeUndefined();
  });

  test("bare key (null value) enables export", () => {
    const agent = load(["name: tprompt-bare", "description: Bare tprompt key parses as null but still opts in", "tprompt:"].join("\n"));
    expect(agent.tprompt.enabled).toBe(true);
    expect(agent.tprompt.title).toBeUndefined();
  });

  test("rejects unknown keys", () => {
    expectReject(["name: tprompt-unknown", "description: Invalid tprompt config", "tprompt:", "  title: Bad", "  shortcut: x"].join("\n"), /Unknown tprompt keys/);
  });

  test("rejects invalid filename", () => {
    expectReject(["name: tprompt-bad-filename", "description: Invalid tprompt filename", "tprompt:", "  filename: 'Bad Name'"].join("\n"), /Invalid tprompt.filename/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// export + skill config + normalization
// ─────────────────────────────────────────────────────────────────────────────

describe("export + skill", () => {
  test("harness defaults to empty", () => {
    const agent = load(MINIMAL_AGENT);
    expect(agent.export).toBe("agent");
    expect(agent.harness.include).toBeUndefined();
    expect(agent.harness.exclude).toBeUndefined();
  });

  test("export accepts skill and none", () => {
    expect(load("name: skill-export\ndescription: Skill export\nexport: skill\n").export).toBe("skill");
    expect(load("name: none-export\ndescription: None export\nexport: none\n").export).toBe("none");
  });

  test("export rejects unknown value", () => {
    expectReject("name: bad-export\ndescription: Bad export\nexport: both\n", /Invalid export/);
  });

  test("skill config parses", () => {
    const agent = load(
      [
        "name: skill-config",
        "description: Has skill config",
        "export: skill",
        "skill:",
        "  name: review-helper",
        "  title: Review Helper",
        "  description: Use when reviewing code.",
        "  tags: [review, code]",
        "  license: MIT",
        "  compatibility: [agent-skills]",
        "  metadata:",
        "    owner: platform",
      ].join("\n"),
    );
    expect(agent.skill.name).toBe("review-helper");
    expect(agent.skill.title).toBe("Review Helper");
    expect(agent.skill.description).toBe("Use when reviewing code.");
    expect(agent.skill.tags).toEqual(["review", "code"]);
    expect(agent.skill.license).toBe("MIT");
    expect(agent.skill.compatibility).toEqual(["agent-skills"]);
    expect(agent.skill.metadata).toEqual({ owner: "platform" });
  });

  test("skill config rejects unknown subkey", () => {
    expectReject(["name: bad-skill", "description: Has bad skill config", "skill:", "  enabled: true"].join("\n"), /Unknown skill keys/);
  });

  test("skill config rejects invalid name", () => {
    expectReject(["name: bad-skill-name", "description: Bad skill name", "export: skill", "skill:", "  name: 'bad name'"].join("\n"), /Invalid skill name/);
  });

  test("skill config rejects too-long name", () => {
    expectReject(["name: long-skill-name", "description: Long skill name", "export: skill", "skill:", `  name: ${"a".repeat(65)}`].join("\n"), /Invalid skill name/);
  });

  test("skill export rejects too-long implicit skill name", () => {
    const longName = "a".repeat(65);
    expectReject([`name: ${longName}`, "description: Long implicit skill name", "export: skill"].join("\n"), /Invalid skill name/);
  });

  test("normalizeSkillName collapses separators", () => {
    expect(normalizeSkillName("  Review__Helper--x  ")).toBe("review-helper-x");
    expect(() => normalizeSkillName("!!!")).toThrow(SchemaError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// harness include / exclude
// ─────────────────────────────────────────────────────────────────────────────

describe("harness include/exclude", () => {
  test("include parses", () => {
    const agent = load(["name: with-include", "description: Has harness.include", "harness:", "  include: [claude, codex]"].join("\n"));
    expect(agent.harness.include).toEqual(["claude", "codex"]);
    expect(agent.harness.exclude).toBeUndefined();
  });

  test("exclude parses", () => {
    const agent = load(["name: with-exclude", "description: Has harness.exclude", "harness:", "  exclude: [tprompt, gemini]"].join("\n"));
    expect(agent.harness.exclude).toEqual(["tprompt", "gemini"]);
    expect(agent.harness.include).toBeUndefined();
  });

  test("rejects both include and exclude", () => {
    expectReject(["name: both", "description: Sets both", "harness:", "  include: [claude]", "  exclude: [tprompt]"].join("\n"), /only one of 'include' or 'exclude'/);
  });

  test("rejects unknown keyword", () => {
    expectReject(["name: bad-keyword", "description: Unknown keyword", "harness:", "  include: [claude, llama]"].join("\n"), /Unknown harness keyword/);
  });

  test("rejects empty include", () => {
    expectReject(["name: empty-include", "description: Empty include", "harness:", "  include: []"].join("\n"), /harness.include .* must not be empty/);
  });

  test("rejects empty exclude", () => {
    expectReject(["name: empty-exclude", "description: Empty exclude", "harness:", "  exclude: []"].join("\n"), /harness.exclude .* must not be empty/);
  });

  test("rejects unknown subkey", () => {
    expectReject(["name: weird-key", "description: Has bad key", "harness:", "  forbid: [claude]"].join("\n"), /Unknown harness keys/);
  });

  test("rejects duplicate keyword", () => {
    expectReject(["name: dup-keyword", "description: Duplicate keyword", "harness:", "  include: [claude, claude]"].join("\n"), /Duplicate harness keyword/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real repository definitions (agents/*/agent.yaml.example + instructions.md)
// ─────────────────────────────────────────────────────────────────────────────

const RETRORABBIT = `
name: retrorabbit-code-reviewer
description: Reviews code hunks for correctness, risk, and maintainability.
defaults:
  sandbox: read-only
  model_strategy: floating
claude:
  tools:
    - Read
    - Grep
    - Glob
  disallowed_tools:
    - Write
  permission_mode: default
  max_turns: 16
codex:
  nickname_candidates:
    - RetroRabbit
gemini:
  tools:
    - read_file
    - grep_search
  max_turns: 16
`;

const CODEXRABBIT = `
name: codexrabbit-code-reviewer
description: Lightweight code reviewer that emits prioritized, structured findings.
defaults:
  sandbox: read-only
  model_strategy: floating
claude:
  tools:
    - Read
    - Grep
    - Glob
  disallowed_tools:
    - Write
  permission_mode: default
  max_turns: 16
codex:
  nickname_candidates:
    - CodexRabbit
gemini:
  tools:
    - read_file
    - grep_search
  max_turns: 16
`;

const PLAN_REVIEWER = `
name: plan-reviewer
description: Skeptical review of implementation plans, design docs, or technical proposals.
defaults:
  sandbox: read-only
  model_strategy: floating
claude:
  tools:
    - Read
    - Grep
    - Glob
  disallowed_tools:
    - Write
  permission_mode: default
  max_turns: 16
gemini:
  tools:
    - read_file
    - grep_search
  max_turns: 16
`;

describe("real repo definitions", () => {
  test("retrorabbit-code-reviewer", () => {
    const agent = load(RETRORABBIT, "You are retrorabbit.\n");
    expect(agent.name).toBe("retrorabbit-code-reviewer");
    expect(agent.description).toBe("Reviews code hunks for correctness, risk, and maintainability.");
    expect(agent.sandbox).toBe("read-only");
    expect(agent.modelStrategy).toBe("floating");
    expect(agent.shouldEmitModelDefaults()).toBe(false);
    expect(agent.claude.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(agent.claude.disallowedTools).toEqual(["Write"]);
    expect(agent.claude.model).toBeUndefined();
    expect(agent.claude.effort).toBeUndefined();
    expect(agent.codex.model).toBeUndefined();
    expect(agent.codex.modelReasoningEffort).toBeUndefined();
    expect(agent.codex.nicknameCandidates).toEqual(["RetroRabbit"]);
    expect(agent.gemini.tools).toEqual(["read_file", "grep_search"]);
    expect(agent.gemini.maxTurns).toBe(16);
    expect(agent.gemini.model).toBeUndefined();
  });

  test("codexrabbit-code-reviewer", () => {
    const agent = load(CODEXRABBIT, "You are codexrabbit.\n");
    expect(agent.name).toBe("codexrabbit-code-reviewer");
    expect(agent.sandbox).toBe("read-only");
    expect(agent.modelStrategy).toBe("floating");
    expect(agent.shouldEmitModelDefaults()).toBe(false);
    expect(agent.harness.include).toBeUndefined();
    expect(agent.harness.exclude).toBeUndefined();
    expect(agent.claude.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(agent.claude.disallowedTools).toEqual(["Write"]);
    expect(agent.claude.maxTurns).toBe(16);
    expect(agent.codex.model).toBeUndefined();
    expect(agent.codex.nicknameCandidates).toEqual(["CodexRabbit"]);
    expect(agent.gemini.tools).toEqual(["read_file", "grep_search"]);
    expect(agent.gemini.maxTurns).toBe(16);
  });

  test("plan-reviewer", () => {
    const agent = load(PLAN_REVIEWER, "You are a staff-level reviewer.\n");
    expect(agent.name).toBe("plan-reviewer");
    expect(agent.sandbox).toBe("read-only");
    expect(agent.modelStrategy).toBe("floating");
    expect(agent.claude.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(agent.gemini.maxTurns).toBe(16);
    expect(agent.codex.nicknameCandidates).toBeUndefined();
  });
});
