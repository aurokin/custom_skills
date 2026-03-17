---
name: convex_guidelines
description: Build, review, or debug Convex applications. Use when working on Convex schema design, queries, mutations, actions, HTTP endpoints, auth, scheduling, file storage, pagination, full-text search, or Convex TypeScript typing.
---

# Convex Skill

Use this skill for Convex backend work. Keep the base context small: read this file first, then open only the reference files that match the task.

## Core workflow

1. Inspect the existing `convex/` tree before proposing changes.
2. Classify the task before loading references:
   - schema, indexes, data model
   - public/internal functions and validators
   - query or mutation behavior
   - Node actions, scheduling, or HTTP routes
   - authentication
   - storage or search
3. Load only the matching reference file(s) from `references/`.
4. Implement using the smallest set of Convex functions needed. Avoid splitting transactional logic across multiple calls unless runtime boundaries force it.
5. Before finishing, verify the result against the always-on rules below.

## Always-on rules

- Define schema in `convex/schema.ts`.
- Add `args` validators to every Convex function, including internal functions and actions.
- Use `query`/`mutation`/`action` only for public API; use `internalQuery`/`internalMutation`/`internalAction` for private helpers.
- Prefer indexed queries. Do not use `filter` in Convex queries.
- Return bounded result sets by default. Prefer `.take(n)` or pagination over `.collect()`.
- Keep Node-only actions in their own `"use node";` files. Do not mix them with queries or mutations.
- Derive user identity server-side with `ctx.auth.getUserIdentity()`; do not accept user IDs for authorization.
- Be strict with generated Convex types such as `Id<"...">`, `Doc<"...">`, and typed ctx helpers.

## Reference map

- Read [references/foundations.md](references/foundations.md) for function registration, validators, function references, calling patterns, and shared TypeScript rules.
- Read [references/schema-and-queries.md](references/schema-and-queries.md) for schema design, indexes, pagination, query limits, ordering, full-text search, and mutation data-write rules.
- Read [references/auth-and-http.md](references/auth-and-http.md) for JWT auth setup, identity handling, and `httpAction` endpoints.
- Read [references/actions-scheduling-storage.md](references/actions-scheduling-storage.md) for Node actions, cron jobs, scheduler patterns, and file storage.
- Read [references/examples.md](references/examples.md) only when you need a compact end-to-end pattern to copy from.

## Loading guidance

- For a new feature touching tables or indexes, read `foundations.md` and `schema-and-queries.md`.
- For bugs in function structure or cross-function calls, read `foundations.md`.
- For auth work, read `auth-and-http.md` first, then `foundations.md` if function structure also changes.
- For webhooks, REST handlers, or uploads, read `auth-and-http.md` or `actions-scheduling-storage.md` based on whether the task is HTTP or storage.
- For background jobs or external API work, read `actions-scheduling-storage.md`.
- For chat-app style backends or when the user asks for a full example, read `examples.md`.

## Output expectations

- Match Convex file-based routing and generated reference usage exactly.
- Call out missing indexes, missing validators, unsafe auth patterns, unbounded reads, and misuse of actions vs queries/mutations.
- When reviewing code, prioritize behavioral bugs and scaling risks over style.
