## Purpose

This repo manages a curated set of agent skills (for Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot) via two mechanisms:
1. **Upstream skills** installed globally from GitHub repos using the `skills` CLI
2. **Local skills** in `skills/` symlinked into `~/.agents/skills` and `~/.claude/skills`

## Key Commands

```bash
# Full sync: remove stale, update existing, add missing upstream skills, then link local skills
./install-repro-skills.sh

# Link local skills only (no upstream sync)
./link-skills.sh

# Override which agents get skills (default: codex opencode gemini-cli github-copilot claude-code)
SKILLS_AGENTS="codex opencode" ./install-repro-skills.sh
```

Requires: `skills` CLI and `jq` on PATH.

## Architecture

- `install-repro-skills.sh` — Declarative sync script. The `specs` array is the source of truth for desired upstream skills. Runs four phases: remove stale, update existing, add missing, link local. Uses `skills list -g --json` to diff current state against desired state. Skills with `@` target a specific skill from a multi-skill repo; without `@` installs all skills from the repo.
- `link-skills.sh` — Symlinks each `skills/<name>/` directory into both `~/.agents/skills/` and `~/.claude/skills/`.
- `skills/<name>/SKILL.md` — Each local skill is a single markdown file with YAML frontmatter (`name`, `description`) followed by the skill prompt content.

## Adding a New Local Skill

Create `skills/<name>/SKILL.md` with frontmatter and prompt content, then run either install script.

## Adding a New Upstream Skill

Add a `"owner/repo@skill-name"` entry to the `specs` array in `install-repro-skills.sh`.
