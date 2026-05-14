## Purpose

This repo manages a curated set of agent skills (for Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot, optionally Hermes) via two mechanisms:
1. **Upstream skills** installed globally from GitHub repos using the `skills` CLI
2. **Local skills** in `skills/` symlinked into `~/.agents/skills` and `~/.claude/skills`

## Key Commands

```bash
# Full sync: remove stale, update existing, add missing upstream skills, then link local skills
./install-repro-skills.sh

# Link local skills only (no upstream sync)
./link-skills.sh

# Refresh the forked agents-md skill from upstream
bash maintenance/sync-agents-md.sh

# Override which agents get skills (default: standard agents from lib/agents.sh —
# codex opencode gemini-cli github-copilot claude-code)
SKILLS_AGENTS="codex opencode" ./install-repro-skills.sh

# Opt in to Hermes (add-only; never removes from ~/.hermes/skills)
SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent" \
    ./install-repro-skills.sh
```

Requires: `skills` CLI and `jq` on PATH. Maintenance sync also uses `curl`.

## Architecture

- `install-repro-skills.sh` — Declarative sync script. The `specs` array is the source of truth for desired upstream skills. Runs four phases: remove stale, update existing, add missing, link local. Uses `skills list -g --json` to diff current state against desired state. Skills with `@` target a specific skill from a multi-skill repo; without `@` installs all skills from the repo.
- `link-skills.sh` — Symlinks each `skills/<name>/` directory into `~/.agents/skills/` and `~/.claude/skills/` (and `~/.hermes/skills/` when `hermes-agent` is opted in).
- `lib/agents.sh` — Defines `STANDARD_AGENTS` and helpers (`compute_skills_agents`, `agents_include_hermes`, `agents_excluding_hermes`). Sourced by both install scripts and `link-skills.sh`.
- `skills/<name>/SKILL.md` — Each local skill is a single markdown file with YAML frontmatter (`name`, `description`) followed by the skill prompt content.

## Hermes Behavior

When `hermes-agent` is in `SKILLS_AGENTS`:
- `install-repro-skills.sh` passes `hermes-agent` to `skills add`. Stale removal is scoped with `-a` to non-Hermes agents so the CLI never deletes from `~/.hermes/skills`.
- A post-removal sweep deletes broken symlinks in `~/.hermes/skills` whose targets resolve into `skills/` or `~/.agents/skills/` (our own dangling writes). Real directories and foreign-target symlinks are never touched.
- `link-skills.sh` adds `~/.hermes/skills` as a symlink target. Stale-link cleanup only removes symlinks pointing back into this repo's `skills/`.
- Without `hermes-agent` in `SKILLS_AGENTS`, scripts never read or write `~/.hermes/skills`.

## Forked Skills

- `skills/agents-md/SKILL.md` — Generated from upstream `getsentry/skills@agents-md` by `maintenance/sync-agents-md.sh`. Do not hand-edit. The Commit Attribution section is removed. CI syncs it weekly.
- `maintenance/test-agents-md.sh` — Validates the generated `agents-md` fork before it is written or committed.

## Adding a New Local Skill

Create `skills/<name>/SKILL.md` with frontmatter and prompt content, then run either install script.

## Adding a New Upstream Skill

Add a `"owner/repo@skill-name"` entry to the `specs` array in `install-repro-skills.sh`.
