# Auth And HTTP

## Table of contents

- Authentication setup
- Identity usage
- Client provider rule
- HTTP endpoints

## Authentication setup

- If a project uses authentication, create `convex/auth.config.ts`.
- Without `convex/auth.config.ts`, `ctx.auth.getUserIdentity()` always returns `null`.
- Convex auth config should point at the JWT issuer and expected audience.

Example:

```ts
export default {
  providers: [
    {
      domain: "https://your-auth-provider.com",
      applicationID: "convex",
    },
  ],
};
```

## Identity usage

- Always derive the current user from `ctx.auth.getUserIdentity()`.
- Do not accept `userId` or similar arguments for authorization decisions.
- Prefer `identity.tokenIdentifier` as the stable lookup key for auth-linked data.
- `identity.subject` is not the preferred global ownership key.

Typical pattern:

```ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const createThing = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized");
    }

    return await ctx.db.insert("things", {
      name: args.name,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });
  },
});
```

## Client provider rule

When Convex auth is used on the client, use `ConvexProviderWithAuth`, not plain `ConvexProvider`:

```tsx
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function App({ children }: { children: React.ReactNode }) {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useYourAuthHook}>
      {children}
    </ConvexProviderWithAuth>
  );
}
```

`useAuth` must return:

- `isLoading`
- `isAuthenticated`
- `fetchAccessToken`

## HTTP endpoints

- Define HTTP routes in `convex/http.ts`.
- Use `httpRouter` from `convex/server`.
- Use `httpAction` from `./_generated/server`.
- The registered route path is the exact `path` string you declare.

Example:

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

## Practical review checklist

- Does the project have `convex/auth.config.ts` when auth is expected?
- Is auth derived from `ctx.auth.getUserIdentity()` instead of request args?
- Is `tokenIdentifier` used for stable ownership lookups?
- Are HTTP endpoints in `convex/http.ts` and wrapped with `httpAction`?
