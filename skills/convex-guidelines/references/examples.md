# Examples

## Table of contents

- Public mutation with validation
- Paginated list query
- Internal helper split
- HTTP echo route

## Public mutation with validation

```ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const createUser = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", { name: args.name });
  },
});
```

## Paginated list query

```ts
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { v } from "convex/values";

export const listMessages = query({
  args: {
    channelId: v.id("channels"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
```

## Internal helper split

Use a private mutation or query when shared transactional work should stay off the public API:

```ts
import {
  internalMutation,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

export const writeAuditLog = internalMutation({
  args: {
    entityId: v.id("tasks"),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auditLogs", args);
    return null;
  },
});

export const completeTask = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    await ctx.db.patch("tasks", args.taskId, { completed: true });
    await ctx.runMutation(internal.tasks.writeAuditLog, {
      entityId: args.taskId,
      message: "completed",
    });
    return null;
  },
});
```

## HTTP echo route

```ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/echo",
  method: "POST",
  handler: httpAction(async (_ctx, req) => {
    const body = await req.bytes();
    return new Response(body, { status: 200 });
  }),
});

export default http;
```
