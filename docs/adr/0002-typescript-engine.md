# ADR 0002: Rewrite the sync engine in TypeScript

- Status: accepted
- Date: 2026-07-10

## Context

The current engine is bash (`install-repro-skills.sh`, `link-skills.sh`,
`lib/*.sh`) with bash test scripts. It works and is tested, but the target
feature set — plan/apply with JSON plans, an ownership state file, an agent
capability registry, per-agent frontmatter rendering, overlay composition —
is data-structure-heavy. JSON manipulation in bash already leans on `jq`
templates and is the known sore point. The owner is explicitly open to
leaving bash now rather than accreting more complexity onto it.

Language options considered: TypeScript (owner's stated lean), Python, Go,
Rust.

## Decision

Rewrite the engine as a TypeScript CLI.

- **Runtime:** Bun where available (fast startup, single-file executable via
  `bun build --compile` for machines without a JS toolchain), written against
  Node-compatible APIs so plain Node can run it too.
- **Distribution:** the CLI lives in this repo (`cli/` or `src/`); machines
  already clone this repo to sync, so `bun run` / a committed build artifact
  covers bootstrap. No npm publish required initially.
- **Ecosystem fit:** the vercel-labs `skills` CLI and most target agents are
  npm/TypeScript projects; reading their JSON output and (if ever needed)
  vendoring their discovery logic is native.

The bash scripts remain during migration as the behavioral reference; the
existing `maintenance/test-*.sh` suites define the contract the TypeScript
engine must reproduce before the scripts are retired.

## Consequences

- Plan/apply JSON, state files, and registry logic get real types and unit
  tests instead of `jq` string assembly.
- New runtime dependency (bun or node) on every fleet machine; mitigated by
  compiled single-file builds committed or fetched at bootstrap.
- Migration period with two implementations; the bash suite is ported to
  golden tests against `plan --json` output to keep parity honest.
