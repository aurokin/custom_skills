# ADR 0004: First-party agents get rendered per-agent frontmatter; shared dir leans Codex

- Status: accepted
- Date: 2026-07-10

## Context

Different agents honor different SKILL.md frontmatter dialects (e.g. Claude
Code parses fields like `allowed-tools`; Codex pairs SKILL.md with an
`agents/openai.yaml` interface descriptor; other agents parse only
`name`/`description`). A single canonical file cannot be optimal for every
agent, and skills placed in per-agent private dirs give us a natural point
to specialize.

The owner designates **Claude Code, Codex, and GitHub Copilot as first-party
citizens**: skills deployed into their private dirs should carry frontmatter
customized to that agent.

A skill placed in the shared `~/.agents/skills` is read by multiple agents
at once, so it can only carry one dialect. Claude Code does not read the
shared dir (it reads `~/.claude/skills`), so Claude's preferences are
irrelevant there; among the shared-dir readers, Codex is the one to
optimize for.

## Consequences of the placement model

Per-agent frontmatter implies **rendering, not symlinking**, whenever a
variant differs from the canonical source: a symlink cannot present
different frontmatter to different readers.

## Decision

1. **Authoring model:** each skill keeps one canonical `SKILL.md`. Optional
   per-agent overrides live alongside it (e.g. `agents/claude.yaml`,
   `agents/openai.yaml`, `agents/copilot.yaml` — final naming in the design
   doc) containing only the fields that differ.
2. **First-party rendering:** when materializing into a first-party agent's
   private dir (`~/.claude/skills`, `~/.codex/skills`, Copilot's dir per the
   capability registry), the engine renders the canonical file merged with
   that agent's override. No override → plain symlink (cheap path).
3. **Shared-dir dialect:** content placed in `~/.agents/skills` uses the
   best cross-agent frontmatter, resolving conflicts in favor of Codex
   conventions, because Codex is the primary shared-dir reader and Claude
   never reads it.
4. **Provenance:** rendered artifacts are copies, so the ownership state
   file (ADR 0006) records their content hash; `status` reports hand-edited
   rendered artifacts as `modified` instead of silently overwriting, and
   private-skill hygiene checks apply to rendered copies exactly as to
   symlinks.

## Consequences

- First-party agents get native-quality skills (tool allowlists, interface
  descriptors) without forking skill content per agent.
- Rendering weakens the "private skills are only ever symlinks" invariant;
  the state file's hashes and `doctor`'s leak scan are the compensating
  controls, and rendered private artifacts must still never land inside a
  git worktree with a non-allowlisted origin.
- Upstream-sourced skills can also be scoped/rendered by materializing from
  a locally vendored copy, since the `skills` CLI's shared-dir install
  cannot express any of this; the design doc defines when vendoring kicks in.
