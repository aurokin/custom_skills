# Exclude Overrides

This document describes the planned user-facing behavior for exclusion
overrides.

`excludeGlobalSpecs` and `excludeFamilySpecs` let `.skills.local.json` subtract
from upstream-managed curated skills as well as add to them.

Use this when the curated catalog is almost right, but you want to remove
specific upstream skills or whole upstream repos from your personal overlay.

## Glossary

- Include: a spec contributed by curated config or additive local config.
- Exclude: a spec in local config that removes matching upstream-managed specs.
- Normalized explicit set: the resolved `owner/repo@skill-name` list after
  repo-wide specs are expanded.
- Family-scoped exclusion: an exclusion that only applies to one curated
  family's resolved contribution.

## Supported Keys

Add these optional keys to `.skills.local.json`:

- `excludeGlobalSpecs`
  exclusions applied to the merged global set used by
  `install-repro-skills.sh`
- `excludeFamilySpecs`
  exclusions keyed by curated family name, applied only to that family's merged
  set during `deploy-project-skills.sh`

Exclusions use the same spec format as the catalog:

- `owner/repo`
- `owner/repo@skill-name`

## Merge Order

Globals:

1. Load curated global includes.
2. Append local `globalSpecs`.
3. Normalize includes to explicit `owner/repo@skill-name` specs.
4. Load and normalize `excludeGlobalSpecs`.
5. Remove excluded specs from the merged explicit set.
6. Dedupe the final explicit set.

Families:

1. Load curated includes for one family.
2. Append local `familySpecs[family]`.
3. Normalize includes to explicit `owner/repo@skill-name` specs.
4. Load and normalize `excludeFamilySpecs[family]`.
5. Remove excluded specs from that family's merged explicit set.
6. Dedupe the final explicit set for that family.
7. Merge selected families and dedupe again across the final deploy set.

`exclude > include` is the precedence rule. Once a spec is excluded, it stays
out of the final resolved set even if it was also added locally.

## Matching Rules

- Matching is exact and case-sensitive after normalization.
- Repo-wide exclusions are allowed.
- Repo-wide includes and excludes are both expanded to current upstream skills
  before exclusions are applied.
- Unknown exclusion specs are valid and silent no-ops.
- Unknown `excludeFamilySpecs` family keys are validation errors.

## Scope Rules

- `excludeGlobalSpecs` only affects global sync.
- `excludeFamilySpecs[family]` only affects that curated family.
- A skill excluded from one family can still be deployed if another selected
  family contributes it.
- Exclusions can remove locally added upstream specs from `globalSpecs` and
  `familySpecs`.
- Exclusions do not remove local repo-managed skills from `skills/`.
- `excludeFamilySpecs` only targets curated families, not `customFamilies`.

## Operational Notes

- Some repo-wide include and exclude cases require enumerating current upstream
  skills.
- If required upstream enumeration fails, the command fails rather than
  guessing.
- Empty results are valid:
  global sync may resolve to zero upstream-managed globals, and family deploy
  may resolve to zero skills after exclusions.

## Examples

Global explicit include plus explicit exclude:

```json
{
  "globalSpecs": [
    "owner/repo@skill-a",
    "owner/repo@skill-b"
  ],
  "excludeGlobalSpecs": [
    "owner/repo@skill-b"
  ]
}
```

Result: `skill-b` is excluded. `skill-a` remains.

Repo-wide include plus explicit exclude after normalization:

```json
{
  "globalSpecs": [
    "owner/repo"
  ],
  "excludeGlobalSpecs": [
    "owner/repo@skill-a"
  ]
}
```

Result: the repo-wide include is expanded first, then `skill-a` is removed from
the normalized explicit set.

Per-family exclusion is family-scoped:

```json
{
  "familySpecs": {
    "expo": [
      "owner/repo@team-skill"
    ]
  },
  "excludeFamilySpecs": {
    "expo": [
      "expo/skills@expo-cicd-workflows",
      "owner/repo@team-skill"
    ]
  }
}
```

Result: both exclusions apply to `expo` only. If another selected family also
contains one of those specs, that other family still contributes it.

Repo-wide exclusion:

```json
{
  "excludeGlobalSpecs": [
    "steipete/clawdis"
  ]
}
```

Result: every current upstream skill from `steipete/clawdis` is removed from the
resolved global set.

Empty-result deploy is valid:

```json
{
  "excludeFamilySpecs": {
    "expo": [
      "expo/skills"
    ]
  }
}
```

Result: if `expo` was the only selected family and nothing else contributes any
remaining specs, deploy is a successful no-op after exclusions.
