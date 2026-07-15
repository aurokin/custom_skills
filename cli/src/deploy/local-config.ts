// Port of lib/catalog.sh's `.skills.local.json` reading + validation (ADR 0014
// decision 3/4). This gitignored quick-tweak file is a REQUIRED input surface of
// `skm deploy`: it carries familySpecs / excludeFamilySpecs / customFamilies (and
// the sync-side globalSpecs / excludeGlobalSpecs / preserveGlobalSkillNames, which
// the port still validates for parity). The whole file is validated whenever any
// accessor runs — invalid shapes fail loudly (bash `ensure_local_skills_config_valid`
// return code 2), a missing file is the expected "no overrides" case (return 1).
//
// Difference from bash: TS parses JSON directly instead of shelling out to jq, so
// there is no jq-missing branch. Spec-line/skill-name/family-name/description
// validation mirrors validate_spec_line / validate_skill_name / validate_family_name
// / validate_family_description exactly.

import * as fs from "node:fs";
import { SPEC_LINE } from "../catalog-specs";

/** A parsed + validated `.skills.local.json`. `present` is false when the file is absent. */
export interface LocalSkillsConfig {
  present: boolean;
  globalSpecs: string[];
  excludeGlobalSpecs: string[];
  preserveGlobalSkillNames: string[];
  familySpecs: Record<string, string[]>;
  excludeFamilySpecs: Record<string, string[]>;
  customFamilies: Record<string, { description: string; specs: string[] }>;
}

/** Curated-family knowledge the validator needs (mirrors curated_family_exists /
 *  curated_family_declared_in_index). */
export interface CuratedFamilyLookup {
  /** Family exists = file present + declared in index + specs valid. */
  exists(name: string): boolean;
  /** Declared in families.tsv column 1 (independent of file validity). */
  declaredInIndex(name: string): boolean;
}

/** Raised for an invalid `.skills.local.json` (bash return code 2 → hard abort). */
export class LocalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalConfigError";
  }
}

const EMPTY: LocalSkillsConfig = {
  present: false,
  globalSpecs: [],
  excludeGlobalSpecs: [],
  preserveGlobalSkillNames: [],
  familySpecs: {},
  excludeFamilySpecs: {},
  customFamilies: {},
};

// ── field-level validators (ports of the lib/catalog.sh validate_* helpers) ──

function isSpecLine(spec: unknown): spec is string {
  return typeof spec === "string" && SPEC_LINE.test(spec);
}

function specHasExplicitSkill(spec: string): boolean {
  return spec.includes("@");
}

/** validate_skill_name: non-empty, no whitespace / '/' / '@'. */
function isSkillName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && !/[\s/@]/.test(name);
}

/** validate_family_name: non-empty, no whitespace. */
function isFamilyName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && !/\s/.test(name);
}

/** validate_family_description: non-empty, no tab / newline. */
function isFamilyDescription(desc: unknown): desc is string {
  return typeof desc === "string" && desc.length > 0 && !desc.includes("\t") && !desc.includes("\n");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/**
 * Load + validate the `.skills.local.json` at `configFile`. A missing file yields
 * the empty config (present:false); any structural or field violation throws
 * LocalConfigError (parity: ensure_local_skills_config_valid return code 2).
 */
export function loadLocalSkillsConfig(configFile: string, curated: CuratedFamilyLookup): LocalSkillsConfig {
  if (!fs.existsSync(configFile)) return EMPTY;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch (e) {
    throw new LocalConfigError(`Invalid local skills config in ${configFile}: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) {
    throw new LocalConfigError(`Invalid local skills config in ${configFile}`);
  }

  const invalid = (): never => {
    throw new LocalConfigError(`Invalid local skills config in ${configFile}`);
  };

  // Top-level shape (jq `.globalSpecs | type == "array"` etc.).
  const globalSpecs = raw.globalSpecs ?? [];
  const excludeGlobalSpecs = raw.excludeGlobalSpecs ?? [];
  const preserveGlobalSkillNames = raw.preserveGlobalSkillNames ?? [];
  const familySpecs = raw.familySpecs ?? {};
  const excludeFamilySpecs = raw.excludeFamilySpecs ?? {};
  const customFamilies = raw.customFamilies ?? {};
  if (!isStringArray(globalSpecs)) invalid();
  if (!isStringArray(excludeGlobalSpecs)) invalid();
  if (!isStringArray(preserveGlobalSkillNames)) invalid();
  for (const n of preserveGlobalSkillNames as unknown[]) if (typeof n !== "string") invalid();
  if (!isPlainObject(familySpecs)) invalid();
  if (!isPlainObject(excludeFamilySpecs)) invalid();
  if (!isPlainObject(customFamilies)) invalid();
  for (const v of Object.values(familySpecs)) if (!isStringArray(v)) invalid();
  for (const v of Object.values(excludeFamilySpecs)) if (!isStringArray(v)) invalid();
  for (const v of Object.values(customFamilies)) {
    if (!isPlainObject(v) || typeof v.description !== "string" || !isStringArray(v.specs)) invalid();
  }

  // globalSpecs / excludeGlobalSpecs entries validate as spec lines.
  for (const spec of globalSpecs as unknown[]) {
    if (!isSpecLine(spec)) throw new LocalConfigError(`Invalid skill spec in ${configFile}: ${String(spec)}`);
  }
  for (const spec of excludeGlobalSpecs as unknown[]) {
    if (!isSpecLine(spec)) throw new LocalConfigError(`Invalid skill spec in ${configFile}: ${String(spec)}`);
  }

  // preserveGlobalSkillNames entries validate as skill names.
  for (const name of preserveGlobalSkillNames as unknown[]) {
    if (!isSkillName(name)) throw new LocalConfigError(`Invalid skill name in ${configFile}: ${String(name)}`);
  }

  // familySpecs keys: valid family name + must be an existing curated family.
  for (const family of Object.keys(familySpecs)) {
    if (!isFamilyName(family)) throw new LocalConfigError(`Invalid family name in ${configFile}: ${family}`);
    if (!curated.exists(family)) {
      throw new LocalConfigError(`Unknown curated family in ${configFile}:familySpecs.${family}`);
    }
  }
  // excludeFamilySpecs keys: valid family name + must be an existing curated family.
  for (const family of Object.keys(excludeFamilySpecs)) {
    if (!isFamilyName(family)) throw new LocalConfigError(`Invalid family name in ${configFile}: ${family}`);
    if (!curated.exists(family)) {
      throw new LocalConfigError(`Unknown curated family in ${configFile}:excludeFamilySpecs.${family}`);
    }
  }

  // familySpecs entry specs validate as spec lines.
  for (const specs of Object.values(familySpecs) as unknown[][]) {
    for (const spec of specs) {
      if (!isSpecLine(spec)) throw new LocalConfigError(`Invalid skill spec in ${configFile}: ${String(spec)}`);
    }
  }
  // excludeFamilySpecs entry specs validate as EXPLICIT spec lines (validate_explicit_spec_line).
  for (const specs of Object.values(excludeFamilySpecs) as unknown[][]) {
    for (const spec of specs) {
      if (!isSpecLine(spec)) throw new LocalConfigError(`Invalid skill spec in ${configFile}: ${String(spec)}`);
      if (!specHasExplicitSkill(spec)) {
        throw new LocalConfigError(`Explicit skill spec required in ${configFile}: ${spec}`);
      }
    }
  }

  // customFamilies: name, description, ≥1 spec, no conflict with a curated index entry, valid specs.
  for (const [family, entry] of Object.entries(customFamilies) as [string, { description: string; specs: unknown[] }][]) {
    if (!isFamilyName(family)) throw new LocalConfigError(`Invalid family name in ${configFile}: ${family}`);
    if (!isFamilyDescription(entry.description)) {
      throw new LocalConfigError(`Invalid family description in ${configFile}:customFamilies.${family}.description`);
    }
    if (entry.specs.length === 0) {
      throw new LocalConfigError(
        `Custom family must define at least one spec in ${configFile}:customFamilies.${family}.specs`,
      );
    }
    if (curated.declaredInIndex(family)) {
      throw new LocalConfigError(`Custom family conflicts with curated family in ${configFile}: ${family}`);
    }
    for (const spec of entry.specs) {
      if (!isSpecLine(spec)) throw new LocalConfigError(`Invalid skill spec in ${configFile}: ${String(spec)}`);
    }
  }

  return {
    present: true,
    globalSpecs: globalSpecs as string[],
    excludeGlobalSpecs: excludeGlobalSpecs as string[],
    preserveGlobalSkillNames: preserveGlobalSkillNames as string[],
    familySpecs: familySpecs as Record<string, string[]>,
    excludeFamilySpecs: excludeFamilySpecs as Record<string, string[]>,
    customFamilies: customFamilies as Record<string, { description: string; specs: string[] }>,
  };
}
