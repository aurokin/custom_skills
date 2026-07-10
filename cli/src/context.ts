// Shared verb bootstrap: load the registry (from this engine's repo), the machine
// config, resolve the desired state, and read ownership state. A registered root
// missing on disk hard-aborts here (exit 1) before any verb does work.

import * as path from "node:path";
import type { SkmEnv } from "./env";
import { loadMachineConfig } from "./machine-config";
import { repoRoot } from "./machine-config";
import { loadRegistry } from "./registry";
import { resolveDesiredState } from "./resolve";
import { loadState } from "./state";
import type { DesiredState, MachineConfig, Registry, StateFile } from "./types";

export interface SkmContext {
  config: MachineConfig;
  registry: Registry;
  desired: DesiredState;
  state: StateFile;
}

/** The engine's authoritative registry file (registry/agents.json in this repo). */
export function registryPath(): string {
  return path.join(repoRoot(), "registry", "agents.json");
}

/**
 * Load everything a verb needs. Throws (→ exit 1) if the registry is invalid or a
 * registered root is missing on disk; resolveDesiredState throws RootMissingError
 * for the latter, honoring "never treat an absent root as delete-its-skills".
 */
export function loadContext(env: SkmEnv): SkmContext {
  const registry = loadRegistry(registryPath());
  const config = loadMachineConfig(env, registry);
  const desired = resolveDesiredState(env, config, registry);
  const state = loadState(env);
  return { config, registry, desired, state };
}
