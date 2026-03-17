# Actions, Scheduling, And Storage

## Table of contents

- Actions
- Scheduling and cron jobs
- File storage

## Actions

- Use actions for external I/O or runtime features that do not belong in Convex transactions.
- Actions do not have `ctx.db`.
- `fetch()` works in the default Convex runtime; do not add `"use node";` just for `fetch()`.
- Add `"use node";` only to files that export Node-runtime actions.
- Do not mix `"use node";` action files with queries or mutations.

Basic action:

```ts
import { action } from "./_generated/server";

export const exampleAction = action({
  args: {},
  handler: async (_ctx) => {
    console.log("This action does not return anything");
    return null;
  },
});
```

If shared logic can stay inside one runtime, prefer a helper function over `ctx.runAction`.

## Scheduling and cron jobs

- Use `ctx.scheduler.runAfter` for deferred work.
- For large bulk mutations, process a bounded batch and schedule the next batch.
- Define cron jobs in `convex/crons.ts`.
- Use `cronJobs`, `crons.interval`, or `crons.cron`.
- Do not use the hourly/daily/weekly helpers.
- Cron jobs take generated function references, not direct function values.
- Import `internal` from `./_generated/api` even when a cron calls an internal function in the same file.

Example:

```ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

export const cleanup = internalAction({
  args: { dryRun: v.boolean() },
  handler: async (_ctx, args) => {
    if (args.dryRun) {
      console.log("dry run");
    }
    return null;
  },
});

const crons = cronJobs();

crons.interval("cleanup every two hours", { hours: 2 }, internal.crons.cleanup, {
  dryRun: false,
});

export default crons;
```

## File storage

- `ctx.storage.getUrl(fileId)` returns a signed URL or `null`.
- Do not use deprecated `ctx.storage.getMetadata`.
- Read storage metadata from the `_storage` system table with `ctx.db.system.get`.
- Convex storage uses `Blob` values when reading or writing files.

Metadata pattern:

```ts
import { query } from "./_generated/server";
import { v } from "convex/values";

export const getFileMetadata = query({
  args: { fileId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.db.system.get("_storage", args.fileId);
  },
});
```

## Practical review checklist

- Are actions free of `ctx.db` usage?
- Is `"use node";` isolated to Node-only action files?
- Are scheduled or cron jobs using generated references?
- Are storage metadata reads going through `_storage` instead of deprecated APIs?
