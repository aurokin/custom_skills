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
