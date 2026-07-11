// Privacy guard (design §9). A private-visibility artifact must never be placed
// inside a git worktree whose `origin` remote is not on the config allowlist.
// The check is a real `git` probe of the nearest existing ancestor of the target.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MachineConfig } from "./types";

/** Nearest existing ancestor directory of `p` (walks up until one exists). */
function nearestExistingDir(p: string): string | undefined {
  let dir = p;
  for (;;) {
    if (fs.existsSync(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * If placing a private artifact at `targetPath` would violate the guard, return a
 * human-readable reason; otherwise undefined. Not-in-a-worktree is always safe.
 */
export function privacyViolation(config: MachineConfig, targetPath: string): string | undefined {
  const probeDir = nearestExistingDir(path.dirname(targetPath));
  if (!probeDir) return undefined;

  const toplevel = git(probeDir, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return undefined; // not inside a git worktree → safe

  const origin = git(probeDir, ["remote", "get-url", "origin"]) ?? "";
  const allow = config.privateOriginAllowlist ?? [];
  if (allow.includes(origin)) return undefined;

  return `private target inside git worktree ${toplevel} whose origin '${origin || "(none)"}' is not allowlisted`;
}
