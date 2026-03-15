# Schema And Queries

## Table of contents

- Schema rules
- Index design
- Query rules
- Pagination and ordering
- Full-text search
- Mutation write rules

## Schema rules

- Always define schema in `convex/schema.ts`.
- Import schema helpers from `convex/server`.
- System fields exist on every document:
  - `_id` with validator `v.id(tableName)`
  - `_creationTime` with validator `v.number()`
- Do not store unbounded child lists inside a single document. Model them as a separate table with a foreign key.

Example:

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  channels: defineTable({
    name: v.string(),
  }),
  messages: defineTable({
    channelId: v.id("channels"),
    body: v.string(),
  }).index("by_channel", ["channelId"]),
});
```

## Index design

- Prefer indexes over query-time filtering.
- Include all indexed fields in the index name.
- Keep index field order aligned with how the query will constrain them.
- If you need both `(field1, field2)` and `(field2, field1)` access patterns, define separate indexes.

Example:

```ts
defineTable({
  ownerId: v.id("users"),
  status: v.string(),
}).index("by_ownerId_and_status", ["ownerId", "status"]);
```

## Query rules

- Do not use `filter` in Convex queries.
- Default to bounded reads:
  - use `.take(n)` for small bounded lists
  - use `.paginate(args.paginationOpts)` for user-facing pagination
- Do not use `.collect().length` for counts. Maintain a denormalized counter if scalable counts matter.
- Use `.unique()` when exactly one row should exist and duplicates should be treated as an error.
- For async iteration over large result sets, use `for await (const row of query)` instead of loading all results eagerly.
- Convex queries do not support `.delete()`.

Example bounded query:

```ts
export const recentMessages = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .order("desc")
      .take(10);
  },
});
```

## Pagination and ordering

Use `paginationOptsValidator` from `convex/server`:

```ts
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { v } from "convex/values";

export const listByAuthor = query({
  args: {
    paginationOpts: paginationOptsValidator,
    author: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_author", (q) => q.eq("author", args.author))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
```

Pagination results contain:

- `page`
- `isDone`
- `continueCursor`

Ordering rules:

- Default ordering is ascending `_creationTime`.
- `.order("asc")` or `.order("desc")` controls ordering explicitly.
- Indexed queries return rows ordered by the indexed fields.

## Full-text search

Use a search index when text relevance matters:

```ts
const messages = await ctx.db
  .query("messages")
  .withSearchIndex("search_body", (q) =>
    q.search("body", "hello hi").eq("channel", "#general"),
  )
  .take(10);
```

## Mutation write rules

- Use `ctx.db.patch("tableName", id, updates)` for shallow partial updates.
- Use `ctx.db.replace("tableName", id, value)` to fully replace an existing document.
- Large bulk work should be batched. If a mutation may exceed transaction limits, process a chunk and schedule continuation with `ctx.scheduler.runAfter`.

Example continuation pattern:

```ts
await ctx.scheduler.runAfter(0, api.tasks.deleteBatch, { cursor });
```

## Practical review checklist

- Are required indexes defined and used?
- Is every list query bounded?
- Is the code avoiding `filter`, `.collect()` for open-ended reads, and `.collect().length` for counts?
- Are bulk deletes or backfills broken into safe batches?
