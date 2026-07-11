// Ownership state I/O (~/.local/state/skills-manager/state.json). The state file
// is the ONLY authority for what skm may delete: apply prunes exactly the
// placements recorded here. Writes are atomic (tmp + rename). Owned by the
// apply/state team.

import * as fs from "node:fs";
import * as path from "node:path";
import { type SkmEnv, statePath } from "./env";
import type { Artifact, StateFile, StatePlacement } from "./types";

// v2 added `tree` (full-artifact hash) to rendered placements for deletion safety
// (finding 2). v1 files load fine — their rendered placements lack `tree` and use
// classifyRemoval's documented legacy fallback until the next apply upgrades them.
const STATE_VERSION = 2;

/** A fresh, empty state for a machine (first run). */
export function emptyState(machine: string): StateFile {
  return { version: STATE_VERSION, machine, artifacts: {} };
}

/** Read state from disk, or an empty state when the file is absent. */
export function loadState(env: SkmEnv): StateFile {
  const file = statePath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState(env.machineName);
    }
    throw err;
  }
  return parseState(raw, file);
}

/** Parse + structurally validate state JSON. Throws a clear error on corruption. */
function parseState(raw: string, file: string): StateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`corrupt state file at ${file}: invalid JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`corrupt state file at ${file}: expected a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "number") {
    throw new Error(`corrupt state file at ${file}: missing numeric 'version'`);
  }
  // Forward-incompatible state (written by a newer skm) must fail loudly rather
  // than have this build silently misread a shape it does not understand. Older
  // versions load fine (missing fields degrade gracefully — see StatePlacement.tree).
  if (obj.version > STATE_VERSION) {
    throw new Error(
      `state file at ${file} is version ${obj.version}, newer than this skm supports (${STATE_VERSION}); upgrade skm`,
    );
  }
  if (typeof obj.machine !== "string") {
    throw new Error(`corrupt state file at ${file}: missing string 'machine'`);
  }
  if (typeof obj.artifacts !== "object" || obj.artifacts === null || Array.isArray(obj.artifacts)) {
    throw new Error(`corrupt state file at ${file}: 'artifacts' must be an object`);
  }
  return parsed as StateFile;
}

/** Persist state atomically: write a sibling tmp file then rename over the target. */
export function saveState(env: SkmEnv, state: StateFile): void {
  const file = statePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Upsert one skill's artifact (source + full placement set). Mutates and returns state. */
export function recordArtifact(
  state: StateFile,
  name: string,
  source: Artifact["source"],
  placements: StatePlacement[],
): StateFile {
  state.artifacts[name] = { source, placements };
  return state;
}

/**
 * Insert or replace a single placement of a skill, preserving the skill's other
 * placements. Used by apply to record one materialized placement at a time.
 * Mutates and returns state.
 */
export function upsertPlacement(
  state: StateFile,
  name: string,
  source: Artifact["source"],
  placement: StatePlacement,
): StateFile {
  const artifact = state.artifacts[name] ?? { source, placements: [] };
  artifact.source = source;
  const want = normalize(placement.path);
  artifact.placements = artifact.placements.filter((p) => normalize(p.path) !== want);
  artifact.placements.push(placement);
  state.artifacts[name] = artifact;
  return state;
}

/**
 * Remove the placement at `targetPath` from a skill's artifact. Drops the
 * artifact entirely once its last placement is gone. Mutates and returns state.
 */
export function removePlacement(state: StateFile, name: string, targetPath: string): StateFile {
  const artifact = state.artifacts[name];
  if (!artifact) return state;
  const want = normalize(targetPath);
  artifact.placements = artifact.placements.filter((p) => normalize(p.path) !== want);
  if (artifact.placements.length === 0) delete state.artifacts[name];
  return state;
}

/** Find which skill (and placement record) owns `targetPath`, if any. */
export function findOwner(
  state: StateFile,
  targetPath: string,
): { skill: string; placement: StatePlacement } | undefined {
  const want = normalize(targetPath);
  for (const [skill, artifact] of Object.entries(state.artifacts)) {
    for (const placement of artifact.placements) {
      if (normalize(placement.path) === want) return { skill, placement };
    }
  }
  return undefined;
}

/**
 * Normalize a placement path for comparison. skm records absolute placement
 * paths (apply resolves dir ids to absolute paths before recording), so a plain
 * resolve is sufficient and no injected env/home is needed here.
 */
function normalize(p: string): string {
  return path.resolve(p);
}
