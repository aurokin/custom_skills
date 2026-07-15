// Review-model assembly (ADR 0013) against a fully fabricated SkmEnv: fake
// HOME, fabricated roots + deploy dirs + state + catalogs. The model is the
// tested surface; stability here is what lets the HTML stay a dumb renderer.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { loadContext } from "../src/context";
import { buildReviewModel } from "../src/review/model";
import type { VerbOptions } from "../src/types";
import { stringify } from "yaml";
import { type Sandbox, makeComposed, makeRoot, makeSandbox, makeSkill, writeMachineConfig } from "./util";

function providerText(name: string, cli: string): string {
  return `---\n${stringify({ name, cli, models: { m1: { default: true } } })}---\n\n# ${name}\n\nAnti-recursion: {{provider_clis}}.\n`;
}

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox({ machineName: "fixture-machine" });
});
afterEach(() => {
  sb.cleanup();
});

const APPLY_OPTS: VerbOptions = { json: true, prune: false, yes: true, fix: false, args: [] };

function writeCatalog(rootPath: string): void {
  const catalogDir = path.join(rootPath, "catalog");
  fs.mkdirSync(path.join(catalogDir, "families"), { recursive: true });
  fs.writeFileSync(
    path.join(catalogDir, "global-specs.txt"),
    "acme/upstream-skills@upstream-skill\nacme/whole-repo\n# comment\n\n",
  );
  fs.writeFileSync(path.join(catalogDir, "families.tsv"), "demo\tDemo family\n");
  fs.writeFileSync(
    path.join(catalogDir, "families", "demo.txt"),
    "acme/upstream-skills@family-skill\n",
  );
}

describe("review model", () => {
  test("assembles units, drift join, inventory, and docs from engine state", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "plain-skill", { body: "plain body" });
    makeSkill(root.path, "gated-skill", {
      frontmatter: { "disable-model-invocation": true },
      body: "gated body",
    });
    writeCatalog(root.path);
    makeComposed(root.path, "orchestrate", {
      skillYaml: {
        posture: "yolo",
        consumers: {
          "claude-code": { description: "Delegate to codex." },
          codex: { description: "Delegate to claude." },
        },
        dimensions: [
          { key: "judgment", candidates: [{ provider: "claude", model: "m1" }, { provider: "codex", model: "m1" }] },
        ],
      },
      template: "# Orchestrate {{consumer}}\n\n{{routing_table}}\n",
      providers: {
        claude: providerText("claude", "claude"),
        codex: providerText("codex", "codex"),
      },
    });
    writeMachineConfig(sb, {
      version: 1,
      roots: [root],
      agents: ["claude-code", "codex"],
    });

    await runApply(sb.env, APPLY_OPTS);

    // Fabricate an upstream install in the shared dir: catalog-expected label.
    const shared = path.join(sb.home, ".agents", "skills");
    fs.mkdirSync(path.join(shared, "upstream-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(shared, "upstream-skill", "SKILL.md"),
      "---\nname: upstream-skill\ndescription: up\n---\n\nbody\n",
    );

    const model = buildReviewModel(sb.env, loadContext(sb.env));

    expect(model.reviewModelVersion).toBe(1);
    expect(model.machine).toBe("fixture-machine");

    const plain = model.units.find((u) => u.name === "plain-skill");
    expect(plain?.group).toBe("Public skills");
    expect(plain?.badges).toContain("symlinked");
    expect(plain?.variants[0]?.files.some((f) => f.path === "SKILL.md")).toBe(true);
    // Placement applied cleanly → drift join says clean.
    expect(plain?.variants[0]?.deployed?.status).toBe("clean");

    const gated = model.units.find((u) => u.name === "gated-skill");
    expect(gated?.badges).toContain("gated");
    // Gated: per-agent rendered variants beyond source.
    expect((gated?.variants.length ?? 0)).toBeGreaterThan(1);

    // Inventory: shared dir present, upstream entry attributed as expectation.
    const sharedDir = model.inventory.find((d) => d.path.endsWith(".agents/skills"));
    expect(sharedDir).toBeDefined();
    const upstream = sharedDir?.entries.find((e) => e.name === "upstream-skill");
    expect(upstream?.kind).toBe("upstream");
    expect(upstream?.label).toContain("catalog-expected · acme/upstream-skills");
    // Docs registered and deduped by real path.
    expect(upstream?.doc).toBeDefined();
    expect(model.docs[upstream!.doc!]?.skill).toContain("body");

    const ours = sharedDir?.entries.find((e) => e.name === "plain-skill");
    expect(ours?.kind).toBe("public");

    // Composed unit: both postures compiled per consumer, self-exclusion intact.
    const composed = model.units.find((u) => u.name === "orchestrate");
    expect(composed?.matrix?.consumers.map((c) => c.key)).toEqual(["claude-code", "codex"]);
    expect(Object.keys(composed?.matrix?.cells ?? {}).sort()).toEqual([
      "claude-code|sandboxed",
      "claude-code|yolo",
      "codex|sandboxed",
      "codex|yolo",
    ]);
    const cell = composed?.matrix?.cells["claude-code|yolo"];
    expect(cell?.files.some((f) => f.path === "SKILL.md")).toBe(true);
    // claude-code's cell must not ship the claude self-reference.
    expect(cell?.files.some((f) => f.path === "references/claude.md")).toBe(false);
    expect(cell?.files.some((f) => f.path === "references/codex.md")).toBe(true);
    // Deployed chip present for the applied consumer placements.
    expect(composed?.matrix?.consumers[0]?.deployed?.status).toBe("clean");
  });

  test("drift join reports modified placements instead of clean", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "gated-skill", {
      frontmatter: { "disable-model-invocation": true },
      body: "gated body",
    });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, APPLY_OPTS);

    // Hand-edit the rendered tree → status must class it modified.
    const rendered = path.join(sb.home, ".claude", "skills", "gated-skill", "SKILL.md");
    fs.appendFileSync(rendered, "\ntampered\n");

    const model = buildReviewModel(sb.env, loadContext(sb.env));
    const gated = model.units.find((u) => u.name === "gated-skill");
    const deployed = gated?.variants.find((v) => v.key === "claude-code")?.deployed;
    expect(deployed?.status).toBe("modified");
  });

  test("model is stable across runs (modulo clock)", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "plain-skill");
    writeCatalog(root.path);
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, APPLY_OPTS);

    const a = buildReviewModel(sb.env, loadContext(sb.env));
    const b = buildReviewModel(sb.env, loadContext(sb.env));
    expect(JSON.stringify({ ...a, built: "" })).toBe(JSON.stringify({ ...b, built: "" }));
  });
});
