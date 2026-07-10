// Regression for doctor's §9 privacy duties:
// - it scans agent dirs for UNMANAGED private content (copies matching a private
//   source hash, or symlinks resolving into a private root) and reports it
//   (privacy-doctor-missing-foreign-leak-class).
// - `--fix` never re-materializes a private artifact into a worktree that has
//   become non-allowlisted since placement (privacy-doctor-fix-bypasses-guard).

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { loadContext } from "../src/context";
import { diagnose, runDoctor } from "../src/doctor";
import type { VerbOptions } from "../src/types";
import { type Sandbox, makeRoot, makeSandbox, makeSkill, writeMachineConfig } from "./util";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.cleanup();
});

function opts(over: Partial<VerbOptions> = {}): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args: [], ...over };
}
function homePath(...p: string[]): string {
  return path.join(sb.home, ...p);
}
function git(dir: string, args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

test("doctor reports an unmanaged COPY of private content in an agent dir", () => {
  const priv = makeRoot(sb, "private", "private");
  const srcDir = makeSkill(priv.path, "secret", { body: "classified inventory" });
  writeMachineConfig(sb, { version: 1, roots: [priv], agents: ["claude-code"] });

  // A stray, unmanaged copy of the private skill lands in the shared dir (not owned
  // in state — never went through apply).
  const leakDir = homePath(".agents/skills/secret");
  fs.mkdirSync(leakDir, { recursive: true });
  fs.copyFileSync(path.join(srcDir, "SKILL.md"), path.join(leakDir, "SKILL.md"));

  const c = loadContext(sb.env);
  const findings = diagnose(sb.env, c.config, c.registry, c.desired, c.state);
  const leak = findings.find(
    (f) => f.category === "private-leak" && f.path && path.resolve(f.path) === path.resolve(leakDir),
  );
  expect(leak).toBeDefined();
  expect(leak!.severity).toBe("error");
});

test("doctor reports an unmanaged SYMLINK resolving into a private root", () => {
  const priv = makeRoot(sb, "private", "private");
  const srcDir = makeSkill(priv.path, "secret");
  writeMachineConfig(sb, { version: 1, roots: [priv], agents: ["claude-code"] });

  const leakLink = homePath(".claude/skills/secret");
  fs.symlinkSync(srcDir, leakLink); // unmanaged symlink into the private root

  const c = loadContext(sb.env);
  const findings = diagnose(sb.env, c.config, c.registry, c.desired, c.state);
  expect(
    findings.some(
      (f) => f.category === "private-leak" && f.path && path.resolve(f.path) === path.resolve(leakLink),
    ),
  ).toBe(true);
});

test("doctor --fix refuses to re-place a private artifact into a now-disallowed worktree", async () => {
  const ORIGIN = "git@github.com:me/trusted.git";
  git(sb.home, ["init", "-q"]);
  git(sb.home, ["remote", "add", "origin", ORIGIN]);

  const priv = makeRoot(sb, "private", "private");
  makeSkill(priv.path, "secret");
  writeMachineConfig(sb, {
    version: 1,
    roots: [priv],
    agents: ["claude-code"],
    privateOriginAllowlist: [ORIGIN], // allowlisted at placement time
  });

  await runApply(sb.env, opts());
  const link = homePath(".claude/skills/secret");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);

  // Origin becomes non-allowlisted; the owned symlink is then deleted.
  git(sb.home, ["remote", "set-url", "origin", "git@github.com:someone/evil.git"]);
  fs.unlinkSync(link);

  const outcome = await runDoctor(sb.env, opts({ fix: true }));
  // --fix must NOT recreate the private placement in the disallowed worktree.
  expect(fs.existsSync(link)).toBe(false);
  const findings = (outcome.json as { findings: { category: string }[] }).findings;
  expect(findings.some((f) => f.category === "private-leak")).toBe(true);
});
