import * as fs from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { loadOverlay, overlayPath } from "../src/overlay";
import { loadRegistry } from "../src/registry";
import type { Registry } from "../src/types";
import { makeOverlay, makeRoot, makeSandbox, realRegistryPath, type Sandbox } from "./util";

function reg(): Registry {
  return loadRegistry(realRegistryPath());
}

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

describe("overlayPath", () => {
  test("points at <root>/overlay.json", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    expect(overlayPath(root)).toBe(`${root.path}/overlay.json`);
  });
});

describe("loadOverlay", () => {
  test("returns undefined when no overlay.json exists", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    expect(loadOverlay(root, reg())).toBeUndefined();
  });

  test("parses scoping and carries name/requiresPublic through", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    makeOverlay(root.path, {
      name: "auro-private",
      requiresPublic: "3abef4e",
      skills: {
        "fleet-ops": { agents: { allow: ["claude-code", "codex"] } },
        "drive-codex": { agents: { deny: ["codex"] } },
      },
    });
    const src = loadOverlay(root, reg());
    expect(src?.name).toBe("auro-private");
    expect(src?.requiresPublic).toBe("3abef4e");
    expect(src?.skills["fleet-ops"]!.agents).toEqual({ allow: ["claude-code", "codex"] });
    expect(src?.skills["drive-codex"]!.agents).toEqual({ deny: ["codex"] });
  });

  test("tolerates an overlay with no skills (all unscoped)", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    fs.writeFileSync(overlayPath(root), JSON.stringify({ version: 1, name: "empty" }));
    const src = loadOverlay(root, reg());
    expect(src?.skills).toEqual({});
  });

  test("rejects an overlay missing its version", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    fs.writeFileSync(overlayPath(root), JSON.stringify({ name: "bad", skills: {} }));
    expect(() => loadOverlay(root, reg())).toThrow(/numeric 'version'/);
  });

  test("validates agent ids against the registry", () => {
    sandbox = makeSandbox();
    const root = makeRoot(sandbox, "private", "private");
    makeOverlay(root.path, { name: "bad", skills: { s: { agents: { allow: ["ghost"] } } } });
    expect(() => loadOverlay(root, reg())).toThrow(/unknown agent 'ghost'/);
  });
});
