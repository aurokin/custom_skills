// `.skills.local.json` load + validation (ADR 0014): invalid shapes must fail
// loudly (parity with lib/catalog.sh ensure_local_skills_config_valid return 2);
// a missing file is the expected "no overrides" case.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type CuratedFamilyLookup, LocalConfigError, loadLocalSkillsConfig } from "../src/deploy/local-config";

let dir: string;
let configFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-config-"));
  configFile = path.join(dir, ".skills.local.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A curated-family lookup where "expo" exists and is index-declared.
const curated: CuratedFamilyLookup = {
  exists: (n) => n === "expo",
  declaredInIndex: (n) => n === "expo",
};

function write(obj: unknown): void {
  fs.writeFileSync(configFile, JSON.stringify(obj));
}

describe("loadLocalSkillsConfig — happy paths", () => {
  test("absent file yields the empty (present:false) config", () => {
    const cfg = loadLocalSkillsConfig(configFile, curated);
    expect(cfg.present).toBe(false);
    expect(cfg.familySpecs).toEqual({});
  });

  test("parses familySpecs / excludeFamilySpecs / customFamilies", () => {
    write({
      familySpecs: { expo: ["a/b@c"] },
      excludeFamilySpecs: { expo: ["a/b@c"] },
      customFamilies: { mine: { description: "Mine", specs: ["c/r@x"] } },
    });
    const cfg = loadLocalSkillsConfig(configFile, curated);
    expect(cfg.present).toBe(true);
    expect(cfg.familySpecs.expo).toEqual(["a/b@c"]);
    expect(cfg.customFamilies.mine!.specs).toEqual(["c/r@x"]);
  });
});

describe("loadLocalSkillsConfig — loud failures", () => {
  test("malformed JSON throws", () => {
    fs.writeFileSync(configFile, "{ not json");
    expect(() => loadLocalSkillsConfig(configFile, curated)).toThrow(LocalConfigError);
  });

  test("non-object top level throws", () => {
    write([1, 2, 3]);
    expect(() => loadLocalSkillsConfig(configFile, curated)).toThrow(/Invalid local skills config/);
  });

  test("globalSpecs of wrong type throws", () => {
    write({ globalSpecs: "not-an-array" });
    expect(() => loadLocalSkillsConfig(configFile, curated)).toThrow(/Invalid local skills config/);
  });

  test("invalid spec line in globalSpecs throws", () => {
    write({ globalSpecs: ["no-slash"] });
    expect(() => loadLocalSkillsConfig(configFile, curated)).toThrow(/Invalid skill spec/);
  });

  test("preserveGlobalSkillNames with a '/' throws", () => {
    write({ preserveGlobalSkillNames: ["owner/repo@x"] });
    expect(() => loadLocalSkillsConfig(configFile, curated)).toThrow(/Invalid skill name/);
  });

  test("familySpecs key that is not an existing curated family throws", () => {
    write({ familySpecs: { nope: ["a/b@c"] } });
    expect(() => loadLocalSkillsConfig(configFile, curated)).toThrow(/Unknown curated family/);
  });

  test("excludeFamilySpecs requires explicit (@) specs", () => {
    write({ excludeFamilySpecs: { expo: ["owner/repo"] } });
    expect(() => loadLocalSkillsConfig(configFile, curated)).toThrow(/Explicit skill spec required/);
  });

  test("customFamilies missing specs throws", () => {
    write({ customFamilies: { mine: { description: "Mine", specs: [] } } });
    expect(() => loadLocalSkillsConfig(configFile, curated)).toThrow(/must define at least one spec/);
  });

  test("customFamilies bad description throws", () => {
    write({ customFamilies: { mine: { description: "", specs: ["c/r@x"] } } });
    expect(() => loadLocalSkillsConfig(configFile, curated)).toThrow(/Invalid family description/);
  });

  test("customFamilies conflicting with a curated index name throws", () => {
    write({ customFamilies: { expo: { description: "Clash", specs: ["c/r@x"] } } });
    expect(() => loadLocalSkillsConfig(configFile, curated)).toThrow(/conflicts with curated family/);
  });
});
