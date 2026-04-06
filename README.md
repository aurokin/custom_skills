# Custom Skills

Custom and upstream skills managed globally via `~/.agents/skills` and `~/.claude/skills`.

## Setup

Run the install script to sync the full skill setup:

```bash
./install-repro-skills.sh
```

This will:
- Remove globally installed skills not in the script's spec list
- Update existing skills to their latest versions
- Add any missing skills
- Audit selected full-coverage upstream repos and warn if they gained undeclared skills
- Link local repo skills into `~/.agents/skills` and `~/.claude/skills`
- Clean up broken symlinks

Default target agents: `codex`, `opencode`, `gemini-cli`, `github-copilot`, `claude-code`. Override with:

```bash
SKILLS_AGENTS="codex opencode" ./install-repro-skills.sh
```

To link local skills only (without syncing upstream):

```bash
./link-skills.sh
```

To refresh the forked `agents-md` skill from upstream:

```bash
bash maintenance/sync-agents-md.sh
```

To run the sync smoke tests:

```bash
bash maintenance/test-install-repro-skills.sh
```

To skip the upstream coverage audit for a run:

```bash
SKILLS_AUDIT_REPO_COVERAGE=0 ./install-repro-skills.sh
```

## Upstream Coverage Audit

Some upstream repos are treated as "full coverage" repos: we want an explicit entry for every upstream skill we intend to carry forward, and we want a warning if upstream adds a new one. This protects against silent drift now that the sync script no longer installs every skill from a repo by default.

The audit configuration lives in `upstream-coverage.json`.

Current audit behavior:
- `vercel-labs/agent-browser` is expected to be fully covered by explicit specs
- `waynesutton/convexskills` is expected to be fully covered except for the intentional exclusion `avoid-feature-creep`

Audited repos are expected to expose skills as `skills/<name>/SKILL.md`. If that layout disappears, the sync will warn that the repo contract may have changed and skip the audit for that repo.

If upstream adds a new skill in one of those repos, `./install-repro-skills.sh` will warn instead of silently installing it.

## Local Skills

| Skill | Description |
|-------|-------------|
| `agents-md` | Fork of `getsentry/skills@agents-md` with commit attribution guidance removed; synced from upstream by `maintenance/sync-agents-md.sh` |
| `plan-reviewer` | Skeptical review of implementation plans/design docs to surface risks, edge cases, and simpler alternatives |

## Adding New Skills

1. Create a new directory under `skills/` with your skill name
2. Add a `SKILL.md` file containing the skill prompt
3. Run `./install-repro-skills.sh` or `./link-skills.sh`

```
skills/
  my-skill/
    SKILL.md
```
