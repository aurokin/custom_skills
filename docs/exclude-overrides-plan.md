# Exclude Overrides Plan

## Goal

Extend `.skills.local.json` so users can subtract from curated upstream-managed
skills in addition to adding to them.

Primary use case:
- a user does not use GitHub and wants to exclude the curated
  `steipete/clawdis@github` global skill

## Non-Goals

- replacing the curated catalog entirely
- removing local repo-managed skills from `skills/`
- introducing pattern matching or fuzzy exclusion rules in v1
- allowing custom families to shadow curated families
- adding persistent cross-run caching

## Config Shape

Add two optional keys to `.skills.local.json`:

```json
{
  "excludeGlobalSpecs": [
    "steipete/clawdis@github"
  ],
  "excludeFamilySpecs": {
    "expo": [
      "expo/skills@expo-cicd-workflows"
    ]
  }
}
```

Rules:
- exclusions use the same spec format as the catalog:
  `owner/repo` or `owner/repo@skill-name`
- `excludeGlobalSpecs` applies only to the merged global set
- `excludeFamilySpecs[family]` applies only to that curated family's merged set
- exclusions may target curated specs or locally added upstream specs
- exclusions do not remove local repo-managed skills from `skills/`
- unknown exclusion specs are silent no-ops
- unknown `excludeFamilySpecs` family keys are validation errors
- `excludeFamilySpecs` only supports curated families, not `customFamilies`

## Core Semantics

### Precedence

`exclude > include`.

That rule applies after normalization. If a repo-wide include expands to
`owner/repo@skill-a`, an explicit exclusion of `owner/repo@skill-a` removes it.

### Normalization

Resolution must normalize both includes and excludes to explicit
`owner/repo@skill-name` specs before filtering.

Implications:
- repo-wide includes are expanded unconditionally
- repo-wide excludes are expanded unconditionally
- matching stays exact and case-sensitive on the normalized explicit set
- the final desired state is always an explicit sorted spec list

### Scope

- `excludeGlobalSpecs` affects global sync only
- `excludeFamilySpecs[family]` affects only that family's resolved contribution
- if two selected families contribute the same spec and only one family excludes
  it, the other family still contributes it

### Failure Behavior

If upstream enumeration is required for normalization or full-coverage
comparison and enumeration fails, the command fails rather than guessing.

### Empty Results

- family deploy resolving to zero specs is a successful no-op
- global sync resolving to zero desired global specs is valid and causes stale
  upstream-managed globals to be removed

## Implementation Plan

### 1. Extend local config validation

File:
- `lib/catalog.sh`

Update `ensure_local_skills_config_valid()` to validate:
- `excludeGlobalSpecs` is an array when present
- `excludeFamilySpecs` is an object when present
- every `excludeGlobalSpecs[*]` value is a valid spec string
- every `excludeFamilySpecs[family][*]` value is a valid spec string
- every `excludeFamilySpecs` key references an existing curated family

Do not require that excluded specs currently exist upstream.

### 2. Add shared normalization and filtering helpers

Files:
- `lib/catalog.sh`
- `lib/upstream-audit.sh` or a small new shared helper if clearer

Add one shared normalization primitive used by globals, families, output, and
audit integration.

Required behavior:
- resolve mixed explicit and repo-wide specs into explicit sorted
  `owner/repo@skill-name` specs
- use one authoritative enumerated upstream skill list per repo per process
- cache enumeration per invocation in process-local memory only
- filter normalized includes by normalized excludes
- dedupe after filtering

Suggested helper responsibilities:
- load local global exclusions
- load local per-family exclusions
- enumerate upstream skill names for one repo with stable sorting
- normalize arbitrary spec arrays to explicit specs
- filter normalized specs by normalized exclusions

### 3. Resolve globals through normalized explicit sets

Files:
- `lib/catalog.sh`
- `install-repro-skills.sh`

Update global resolution to:
1. load curated globals
2. append local `globalSpecs`
3. normalize includes
4. load and normalize `excludeGlobalSpecs`
5. filter excluded specs
6. dedupe the final explicit set

Expected effects:
- `desired_names` comes from the final resolved explicit set
- excluded installed globals become stale and are removed
- repo-wide include plus explicit exclude works as expected
- repo-wide exclude removes all current upstream skills from that repo

### 4. Resolve family deploy through normalized explicit sets

Files:
- `lib/catalog.sh`
- `deploy-project-skills.sh`

Update family resolution to:
1. resolve each selected family independently through the same normalized flow
2. merge selected family results
3. dedupe the final explicit deploy set

Important constraint:
- `deploy-project-skills.sh` can no longer rely on raw repo-wide
  `skills add --copy` semantics for partially excluded repos
- execution should work from the final explicit per-repo skill list

Even if a repo ends with full final coverage and receives the `^` marker,
execution may still use explicit `-s` skill lists in v1. Marker semantics and
execution strategy should stay decoupled.

### 5. Add resolved repo summaries and full-coverage marker

Files:
- `install-repro-skills.sh`
- `deploy-project-skills.sh`

Add a resolved repo summary to both workflows.

Requirements:
- repos sorted by repo name
- skills sorted within each repo
- full explicit final skill list printed for each repo
- omit repos that resolve to zero skills
- add a `^` marker when the final resolved set covers all current upstream
  skills for that repo
- include a legend explaining `^`
- base marker logic on final coverage after exclusions, not declaration
  provenance
- use the same shared enumerated upstream skill list used by normalization

### 6. Integrate exclusions with coverage audit

Files:
- `install-repro-skills.sh`
- `deploy-project-skills.sh`
- `lib/upstream-audit.sh`

Adjust effective audit inputs so excluded skills do not look like coverage
drift.

Requirements:
- local exclusions suppress audit warnings for intentionally removed skills
- repo-wide exclusions suppress audit warnings for all expanded skills in that
  repo
- coverage manifests remain audit metadata only and do not affect resolution

### 7. Update documentation structure

Files:
- `README.md`
- `.skills.local.json.example`
- `docs/exclude-overrides.md`
- `docs/exclude-overrides-plan.md`

Documentation responsibilities:
- `README.md`
  concise feature mention, link to the behavior doc, and output notes for the
  resolved repo summary and `^` legend
- `docs/exclude-overrides.md`
  user-facing semantics, glossary, ordered merge sequence, scope rules, and
  complete config examples
- `docs/exclude-overrides-plan.md`
  implementation plan and design notes
- `.skills.local.json.example`
  compact example showing the new exclusion keys

Before deleting the old root plan, audit it for any content that should be
extracted into user-facing docs or README notes.

### 8. Move docs under `docs/`

Files:
- `docs/exclude-overrides.md`
- `docs/exclude-overrides-plan.md`

Repo docs convention:
- ordinary human-facing markdown docs live under `docs/`
- root exceptions include `README.md`, `AGENTS.md`, and `CLAUDE.md`

Remove the old root `EXCLUDE_OVERRIDES_PLAN.md` after its useful content is
extracted.

### 9. Expand test coverage

Files:
- `maintenance/test-install-repro-skills.sh`
- `maintenance/test-deploy-project-skills.sh`

Add tests for:
- global exclusion removes a curated global spec from desired state
- excluded installed global skill is removed as stale
- repo-wide include plus explicit exclude removes only the targeted skill
- repo-wide exclusion removes all current upstream skills from that repo
- family exclusion removes a curated family spec from deploy output
- exclusion wins if the same spec is also supplied by additive local config
- a family-specific exclusion does not suppress the same spec contributed by
  another selected family
- empty-result deploy succeeds with the expected no-op messaging
- empty-result global sync removes stale globals and reports the empty desired
  state clearly
- invalid `excludeGlobalSpecs` schema fails validation
- invalid `excludeFamilySpecs` schema fails validation
- unknown excluded spec is ignored without warning
- resolved repo summaries print exact sorted lines, marker placement, and legend
- audit warnings are suppressed for locally excluded skills

## Recommended Scope

Implement only:
- `excludeGlobalSpecs`
- `excludeFamilySpecs`
- unconditional normalization to explicit specs
- per-invocation repo enumeration cache
- resolved repo summaries with the `^` legend

Defer:
- excluding custom families by name
- wildcard exclusions
- excluding local repo-managed skills
- name-only exclusion aliases
- persistent caching across runs
- execution-path optimization that collapses full-coverage repos back to raw
  repo-wide installs
