import * as fs from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { auditPath } from "../src/env";
import { appendAudit, makeAuditEntry } from "../src/audit";
import { makeSandbox, type Sandbox } from "./util";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

/** Run `fn` with process.env's operator markers set to `overrides`, then restore. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const keys = ["CLAUDECODE", "CODEX_HOME", "USER", "LOGNAME"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) {
      const v = overrides[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("makeAuditEntry", () => {
  test("stamps timestamp from env.clock and machine from env", () => {
    sandbox = makeSandbox({ machineName: "koopa" });
    withEnv({ USER: "auro" }, () => {
      const e = makeAuditEntry(sandbox!.env, "apply", "created 3 placements", "abc123");
      expect(e.timestamp).toBe("2026-07-10T00:00:00.000Z");
      expect(e.machine).toBe("koopa");
      expect(e.verb).toBe("apply");
      expect(e.summary).toBe("created 3 placements");
      expect(e.planHash).toBe("abc123");
    });
  });

  test("omits planHash when not provided", () => {
    sandbox = makeSandbox();
    withEnv({ USER: "auro" }, () => {
      const e = makeAuditEntry(sandbox!.env, "plan", "no changes");
      expect("planHash" in e).toBe(false);
    });
  });

  test("operator is claude-code when CLAUDECODE is set", () => {
    sandbox = makeSandbox();
    withEnv({ CLAUDECODE: "1", USER: "auro" }, () => {
      expect(makeAuditEntry(sandbox!.env, "apply", "x").operator).toBe("claude-code");
    });
  });

  test("operator is codex when only CODEX_HOME is set", () => {
    sandbox = makeSandbox();
    withEnv({ CODEX_HOME: "/home/x/.codex", USER: "auro" }, () => {
      expect(makeAuditEntry(sandbox!.env, "apply", "x").operator).toBe("codex");
    });
  });

  test("operator falls back to $USER when no agent markers are set", () => {
    sandbox = makeSandbox();
    withEnv({ USER: "auro" }, () => {
      expect(makeAuditEntry(sandbox!.env, "apply", "x").operator).toBe("auro");
    });
  });

  test("operator is 'unknown' when nothing identifies the caller", () => {
    sandbox = makeSandbox();
    withEnv({}, () => {
      expect(makeAuditEntry(sandbox!.env, "apply", "x").operator).toBe("unknown");
    });
  });
});

describe("appendAudit", () => {
  test("appends one JSON line per call, creating the log dir", () => {
    sandbox = makeSandbox();
    withEnv({ USER: "auro" }, () => {
      appendAudit(sandbox!.env, makeAuditEntry(sandbox!.env, "plan", "first"));
      appendAudit(sandbox!.env, makeAuditEntry(sandbox!.env, "apply", "second", "h1"));
    });
    const lines = fs.readFileSync(auditPath(sandbox.env), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).verb).toBe("plan");
    expect(JSON.parse(lines[1]!)).toMatchObject({ verb: "apply", planHash: "h1", summary: "second" });
  });
});
