// Loads + validates the agent capability registry (registry/agents.json) and
// exposes the read-graph helpers placement is computed from.

import * as fs from "node:fs";
import { RegistryError } from "./errors";
import { type SkmEnv, expandTilde } from "./env";
import type { MachineConfig, Registry } from "./types";

/** Parse + validate a registry file. */
export function loadRegistry(filePath: string): Registry {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new RegistryError(`registry not found: ${filePath}`);
  }
  const parsed = JSON.parse(raw) as Registry;
  validateRegistry(parsed);
  return parsed;
}

/**
 * Schema-check a parsed registry:
 * - every reads/maybeReads/ownDir id must exist in `directories`
 * - every `supported` agent must declare an ownDir
 * Throws RegistryError on the first violation.
 */
export function validateRegistry(reg: Registry): void {
  if (!reg.directories || !reg.agents) {
    throw new RegistryError("registry missing `directories` or `agents`");
  }
  const dirIds = new Set(Object.keys(reg.directories));

  for (const [agentId, agent] of Object.entries(reg.agents)) {
    for (const d of agent.reads) {
      if (!dirIds.has(d)) {
        throw new RegistryError(`agent '${agentId}' reads unknown directory '${d}'`);
      }
    }
    for (const d of agent.maybeReads) {
      if (!dirIds.has(d)) {
        throw new RegistryError(`agent '${agentId}' maybeReads unknown directory '${d}'`);
      }
    }
    if (agent.ownDir !== undefined && !dirIds.has(agent.ownDir)) {
      throw new RegistryError(`agent '${agentId}' ownDir '${agent.ownDir}' not in directories`);
    }
    if (agent.skillsSupport === "supported" && agent.ownDir === undefined) {
      throw new RegistryError(`supported agent '${agentId}' has no ownDir`);
    }
  }
}

/**
 * Agent ids that read `dirId`. With `includeMaybe`, unconfirmed reads count too
 * (the deny-guarantee view: an agent that *might* read the dir is a reader).
 */
export function readersOf(
  reg: Registry,
  dirId: string,
  opts: { includeMaybe?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const [agentId, agent] of Object.entries(reg.agents)) {
    if (agent.reads.includes(dirId) || (opts.includeMaybe && agent.maybeReads.includes(dirId))) {
      out.push(agentId);
    }
  }
  return out;
}

/** Default enabled set: every `supported` agent except hermes (hermes is opt-in). */
export function defaultEnabledAgents(reg: Registry): string[] {
  return Object.entries(reg.agents)
    .filter(([id, a]) => a.skillsSupport === "supported" && id !== "hermes")
    .map(([id]) => id);
}

/** Enabled agents for a config: explicit `agents` if present, else the default set. */
export function enabledAgents(config: MachineConfig, reg: Registry): string[] {
  if (config.agents !== undefined) return config.agents;
  return defaultEnabledAgents(reg);
}

/** Resolve a directory id to an absolute path (tilde expanded against env.home). */
export function dirPath(env: SkmEnv, reg: Registry, dirId: string): string {
  const dir = reg.directories[dirId];
  if (!dir) throw new RegistryError(`unknown directory '${dirId}'`);
  return expandTilde(env, dir.path);
}
