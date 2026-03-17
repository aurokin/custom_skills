# Foundations

## Table of contents

- Function registration
- Validators
- Function references and calling
- TypeScript rules

## Function registration

- Public API functions use `query`, `mutation`, and `action` from `./_generated/server`.
- Private helpers use `internalQuery`, `internalMutation`, and `internalAction` from `./_generated/server`.
- Do not register functions through `api` or `internal`.
- Keep sensitive logic private unless it is intentionally part of the app's public API.

## Validators

- Every Convex function must declare `args`, even if it is `{}`.
- Always validate all arguments for `query`, `mutation`, `action`, `internalQuery`, `internalMutation`, and `internalAction`.
- Common validators:
  - `v.id("table")`
  - `v.string()`
  - `v.number()`
  - `v.boolean()`
  - `v.null()`
  - `v.int64()`
  - `v.bytes()`
  - `v.array(...)`
  - `v.object({...})`
  - `v.record(keyValidator, valueValidator)`
  - `v.union(...)`
  - `v.literal("value")`

Use discriminated unions for structured variants:

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  results: defineTable(
    v.union(
      v.object({
        kind: v.literal("error"),
        errorMessage: v.string(),
      }),
      v.object({
        kind: v.literal("success"),
        value: v.number(),
      }),
    ),
  ),
});
```

## Function references and calling

- Use `api` from `convex/_generated/api` for public functions.
- Use `internal` from `convex/_generated/api` for internal functions.
- File-based routing examples:
  - `convex/example.ts` -> `api.example.myFunction`
  - `convex/messages/access.ts` -> `api.messages.access.myFunction`
  - internal helpers follow the same path under `internal`

Calling rules:

- `ctx.runQuery` may be used from queries, mutations, and actions.
- `ctx.runMutation` may be used from mutations and actions.
- `ctx.runAction` may only be used from actions.
- Avoid action-to-action calls unless you must cross runtimes. Prefer shared helpers instead.
- Minimize action-to-query and action-to-mutation round trips because they split transactional logic and can create race conditions.

When calling a function in the same file through a generated reference, annotate the return type to avoid TypeScript circularity issues:

```ts
import { query } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";

export const greet = query({
  args: { name: v.string() },
  handler: async (_ctx, args) => {
    return `Hello ${args.name}`;
  },
});

export const caller = query({
  args: {},
  handler: async (ctx) => {
    const message: string = await ctx.runQuery(api.example.greet, {
      name: "Bob",
    });
    return message;
  },
});
```

## TypeScript rules

- Prefer `Id<"table">` over plain `string` for document IDs.
- Use `Doc<"table">` for full document types.
- Use `QueryCtx`, `MutationCtx`, and `ActionCtx` from `./_generated/server` when helpers need an explicit ctx type.
- Do not use `any` for `ctx`.
- For record types, match the validator exactly. Example:

```ts
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";

export const usernamesById = query({
  args: { userIds: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    const result: Record<Id<"users">, string> = {};
    for (const userId of args.userIds) {
      const user = await ctx.db.get(userId);
      if (user) {
        result[user._id] = user.username;
      }
    }
    return result;
  },
});
```

## Practical review checklist

- Is every function registered with the correct public or internal wrapper?
- Does every function have validators?
- Are generated function references used instead of importing callees directly into `runQuery`/`runMutation`/`runAction`?
- Are IDs and ctx types strongly typed?
