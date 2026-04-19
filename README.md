# Custom Skills

Curated local and upstream skills for multiple coding agents.

This repo has two distinct workflows:

1. Global normalization for your personal always-on setup
2. Project deployment for repo-specific skill families like Expo and Convex

It also supports an optional gitignored personal overlay file for extra global
skills, per-family additions, and custom project families.

## Requirements

- `skills` CLI
- `jq`
- `git`
- `curl` for the `agents-md` sync maintenance script

## Scripts

### `./install-repro-skills.sh`

Normalizes your global skill setup under `~/.agents/skills` and `~/.claude/skills`.

It will:
- remove globally installed skills that are no longer in the curated global catalog
- update existing global skills
- add any missing curated global skills
- audit selected upstream repos for coverage drift
- link local repo skills into both global skill directories
- clean up broken symlinks in those global directories

Use it when you want to update your personal baseline skill environment.

If `.skills.local.json` exists, its `globalSpecs` are merged into the desired
global set before stale-skill removal runs.

Planned exclusion-override behavior and planned resolved summary output are
documented in
[docs/exclude-overrides.md](/home/auro/code/custom_skills/docs/exclude-overrides.md:1)
and
[docs/exclude-overrides-plan.md](/home/auro/code/custom_skills/docs/exclude-overrides-plan.md:1).
The planned summary marker is `^`, meaning the final resolved set covers all
current upstream skills for that repo.

Examples:

```bash
./install-repro-skills.sh
SKILLS_AGENTS="codex opencode" ./install-repro-skills.sh
SKILLS_AUDIT_REPO_COVERAGE=0 ./install-repro-skills.sh
```

### `./deploy-project-skills.sh`

Deploys curated skill families into a target directory with project-scoped `skills add --copy` installs.

Use it when a repo needs a focused set of skills, for example Expo or Convex, without making them part of your global always-on setup.

If `.skills.local.json` exists, its `familySpecs` extend curated families and
its `customFamilies` become selectable alongside the curated ones.

Behavior:
- targets the exact directory you choose
- expands current-user `~` and `~/...` target paths, including interactive input and quoted `--target` values
- does not expand `~user/...` target paths
- works in plain directories and git repos
- copies skills into the project-managed agent directories
- installs only the selected families
- does not normalize or remove unrelated project skills
- audits selected curated family repos for upstream drift when coverage manifests are configured

Planned exclusion-override behavior and planned resolved summary output are
documented in
[docs/exclude-overrides.md](/home/auro/code/custom_skills/docs/exclude-overrides.md:1)
and
[docs/exclude-overrides-plan.md](/home/auro/code/custom_skills/docs/exclude-overrides-plan.md:1).
The planned summary marker is `^`, meaning the final resolved set covers all
current upstream skills for that repo.

Interactive mode:

```bash
./deploy-project-skills.sh --interactive
```

Non-interactive mode:

```bash
./deploy-project-skills.sh \
  --target ~/code/my-app \
  --family expo \
  --family convex \
  --agents "codex claude-code" \
  --yes
```

List available families:

```bash
./deploy-project-skills.sh --list-families
```

### `./link-skills.sh`

Symlinks local repo skills from `skills/` into:
- `~/.agents/skills`
- `~/.claude/skills`

Use it when you only want to refresh local repo skills without touching upstream packages.

```bash
./link-skills.sh
```

### `bash maintenance/sync-agents-md.sh`

Refreshes the forked `agents-md` local skill from upstream `getsentry/skills@agents-md`.

`skills/agents-md/SKILL.md` is generated output. Do not edit it by hand.

```bash
bash maintenance/sync-agents-md.sh
```

## Catalog

The source of truth is split by purpose:

- `catalog/global-specs.txt`
  global skills managed by `install-repro-skills.sh`
- `catalog/families.tsv`
  family names and descriptions for project deployment
- `catalog/families/*.txt`
  explicit per-family upstream skill specs
- `catalog/family-coverage.json`
  upstream repos that should be audited for family drift

Current project families:
- `expo`
- `convex`

## Personal Overlay

Create `.skills.local.json` in the repo root to add personal skills without
changing the curated catalog. The file is gitignored; start from
`.skills.local.json.example`.

Supported keys:

- `globalSpecs`
  additive upstream specs merged into `install-repro-skills.sh`
- `familySpecs`
  additive specs keyed by existing curated family name
- `customFamilies`
  new family definitions with `description` and `specs`

See [docs/exclude-overrides.md](/home/auro/code/custom_skills/docs/exclude-overrides.md:1)
for the planned exclusion-override semantics, normalization rules, and
examples.

Example:

```json
{
  "globalSpecs": [
    "owner/repo@my-global-skill"
  ],
  "familySpecs": {
    "expo": [
      "owner/repo@my-expo-skill"
    ]
  },
  "customFamilies": {
    "acme-mobile": {
      "description": "Company mobile workflow skills",
      "specs": [
        "owner/repo@release-ops"
      ]
    }
  }
}
```

Rules:

- local config is additive today
- `familySpecs` can only target existing curated families
- `customFamilies` cannot reuse a curated family name
- duplicate specs are deduped with curated entries first

## Local Skills

Local repo-managed skills live in `skills/<name>/SKILL.md`.

Current local skills:
- `agents-md`
- `to-prd` — forked from `mattpocock/to-prd`
- `to-issues` — forked from `mattpocock/to-issues`

The `to-prd` and `to-issues` skills are maintained here as local forks rather
than installed upstream packages.

To add a new local skill:

1. Create `skills/<name>/SKILL.md`
2. Add frontmatter with `name` and `description`
3. Run `./link-skills.sh` or `./install-repro-skills.sh`

## Tests

Run the shell test scripts directly:

```bash
bash maintenance/test-install-repro-skills.sh
bash maintenance/test-link-skills.sh
bash maintenance/test-deploy-project-skills.sh
bash maintenance/test-agents-md.sh
```
