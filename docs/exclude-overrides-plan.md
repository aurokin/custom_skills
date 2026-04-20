# Exclude Overrides Plan

This document summarizes the implemented architecture and test scope for the
exclude-overrides work.

## Goal

Support additive and subtractive local overlays without changing the curated
catalog:

- Global sync can add specs and exclude explicit skills or whole upstream repos.
- Curated family deploys can add specs and exclude explicit skills per family.
- Global sync operates on a final resolved explicit skill set.
- Family deploy operates on a final post-exclusion deploy set that may contain
  repo-wide specs for fully surviving repos and explicit specs for narrowed
  repos.

## Implemented Architecture

### Shared concepts

- Curated specs are loaded first.
- Local additive specs are appended from `.skills.local.json`.
- When required, repo-wide specs are expanded to explicit
  `owner/repo@skill-name` entries by enumerating current upstream skills.
- Exclusions are applied after normalization with `exclude > include`
  precedence.
- The final resolved state drives stale removal, install batching, summaries,
  and coverage auditing. For global sync that state is explicit; for family
  deploy it may preserve repo-wide specs when exclusions do not narrow a repo.

### Global sync

`install-repro-skills.sh` resolves the desired global upstream-managed state in
this order:

1. Load curated global specs.
2. Append local `globalSpecs`.
3. Expand repo-wide includes to explicit specs.
4. Load local `excludeGlobalSpecs`.
5. Resolve repo-wide exclusions against the available expanded set.
6. Filter excluded specs from the expanded set.
7. Use the final explicit result for stale removal, install batching, summaries,
   and coverage audit.

### Family deploy

`deploy-project-skills.sh` resolves each selected curated family
independently:

1. Load curated family specs.
2. Append local `familySpecs[family]`.
3. If the family has exclusions, expand repo-wide includes to explicit specs.
4. Load local `excludeFamilySpecs[family]`.
5. Filter excluded specs from that family's resolved contribution.
6. Preserve repo-wide installs only when the full repo still survives after
   filtering; otherwise fall back to explicit remaining specs.
7. Merge all selected family results into one deduped deploy set containing
   repo-wide specs for untouched repos and explicit specs for narrowed repos.

Custom families are additive only. They are selectable for deploys, but
`excludeFamilySpecs` does not target them.

## Summaries And Audit

- Resolved repo summaries are printed from the final post-exclusion skill set.
- `^` marks repos where the final resolved set covers all currently enumerated
  upstream skills for that repo.
- Coverage auditing also uses the effective post-exclusion desired state, so
  intentionally removed skills do not show up as drift.
- Fully excluded repos can still participate in coverage audit when the manifest
  says they should be checked.
- Upstream enumeration is cached per repo within one invocation and reused by
  normalization, summaries, and audit.

## Validation Boundaries

- `excludeGlobalSpecs` accepts repo-wide or explicit specs.
- `excludeFamilySpecs` accepts explicit specs only.
- Unknown explicit or repo-wide exclusions are silent no-ops.
- Unknown `excludeFamilySpecs` family keys are validation errors.
- Empty resolved results are valid for both global sync and family deploy.
- Local repo-managed skills under `skills/` are never removed by exclusions.

## Test Coverage

The shell integration suites cover the user-visible behavior:

- `maintenance/test-install-repro-skills.sh`
  verifies global exclusion precedence, repo-wide normalization, stale removal,
  empty results, resolved summaries, `^` markers, and exclusion-aware coverage
  audit.
- `maintenance/test-deploy-project-skills.sh`
  verifies family-scoped exclusions, overlap across families, exact deploy
  batches, empty deploy results, resolved summaries, `^` markers, fully
  excluded repo audit behavior, and validation failures.

The tests are process-level rather than unit-level because the core behavior in
this repo is shell orchestration across catalog loading, normalization, audit,
and CLI invocation.
