# Express

> Mount the realtime avatar proxy as Express middleware — Express 4 or 5 — with the same authorize and session policy every adapter takes.

- Canonical: https://realtimeavatar.ai/docs/express
- Updated: 2026-09-02

Your API key must never reach a browser, so the browser talks to your app and your app talks to us. In Express that is one middleware.

## The server half

Express 4 and 5. Mount it on a path prefix, with a JSON body parser in front — the adapter reads a parsed body rather than a stream.

**Express**

```ts
import express from "express";
import { realtimeAvatarExpress } from "realtime-avatar/express";

const app = express();

app.use(
  "/api/realtime-avatar",
  express.json(),
  realtimeAvatarExpress({
    apiKey: process.env.REALTIME_AVATAR_API_KEY!,

    authorize: async ({ request, operation }) => {
      const user = await currentUser(request);
      if (!user) return new Response("Sign in", { status: 401 });
      if (operation === "connect" && !user.credits) {
        return Response.json({ code: "insufficient_credits" }, { status: 402 });
      }
    },

    session: async ({ avatarId }) => ({
      instructions: promptFor(avatarId),
    }),
  }),
);
```

`express.json()` is not optional here. Express hands the adapter an already-parsed body, which it re-serializes to forward — fine for this route, whose payloads are small, but it is the reason the Fetch-based adapters ([Hono](https://realtimeavatar.ai/docs/hono), [Next.js](https://realtimeavatar.ai/docs/nextjs), [TanStack Start](https://realtimeavatar.ai/docs/tanstack-start)) are the better path when you have the choice.

## The client half

Express serves your API; the browser half is the same component as everywhere else, pointed at the prefix you mounted.

**React**

```tsx
import { AvatarCall, createProxyClient } from "realtime-avatar/react";

const client = createProxyClient({ proxyUrl: "/api/realtime-avatar" });

<AvatarCall client={client} avatarId={avatarId} />
```

If your React app is served from a different origin than the Express API, give `proxyUrl` the absolute URL and allow credentials in your CORS policy — the proxy is your endpoint, so its auth is your session, not ours.

## Next

- [Authentication](https://realtimeavatar.ai/docs/authentication) — keys, scopes, and what `authorize` is really gating.
- [Calls](https://realtimeavatar.ai/docs/sessions) — everything the `session` policy can decide.

---

Realtime Avatar — realtime AI avatar API & SDK. Docs: https://realtimeavatar.ai/docs · Agent guide: https://realtimeavatar.ai/llms.txt
