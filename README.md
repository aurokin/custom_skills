# Custom Skills

Curated local and upstream skills for multiple coding agents.

This repo has two distinct workflows:

1. Global normalization for your personal always-on setup
2. Project deployment for repo-specific skill families like Expo and Convex

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

Examples:

```bash
./install-repro-skills.sh
SKILLS_AGENTS="codex opencode" ./install-repro-skills.sh
SKILLS_AUDIT_REPO_COVERAGE=0 ./install-repro-skills.sh
```

### `./deploy-project-skills.sh`

Deploys curated skill families into a target directory with project-scoped `skills add --copy` installs.

Use it when a repo needs a focused set of skills, for example Expo or Convex, without making them part of your global always-on setup.

Behavior:
- targets the exact directory you choose
- expands a leading `~` in target paths, including interactive input and quoted `--target` values
- works in plain directories and git repos
- copies skills into the project-managed agent directories
- installs only the selected families
- does not normalize or remove unrelated project skills
- audits selected curated family repos for upstream drift when coverage manifests are configured

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

## Local Skills

Local repo-managed skills live in `skills/<name>/SKILL.md`.

Current local skills:
- `agents-md`

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
