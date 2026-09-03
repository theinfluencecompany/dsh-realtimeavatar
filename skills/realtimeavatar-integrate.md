---
name: realtimeavatar-integrate
description: Realtime Avatar SDK integration for Next.js, TanStack Start, Express, Hono/Workers/Bun/Deno and React/React Native: the server route adapter that holds the key and the AvatarCall / useAvatarCall client half.
snapshot: 2026-09-03
sources: docs/nextjs.md, docs/tanstack-start.md, docs/express.md, docs/hono.md, docs/react.md
---

> Snapshot of the public documentation at https://realtimeavatar.ai taken on 2026-09-03. For the current text of any page call the `rta_docs` tool; the canonical pages are linked under every section.

## Next.js

Source: https://realtimeavatar.ai/docs/nextjs (markdown: https://realtimeavatar.ai/docs/nextjs.md, updated 2026-09-02)

> Mount the realtime avatar proxy in a Next.js App Router project: one route file on the server, one component in the browser.

- Canonical: https://realtimeavatar.ai/docs/nextjs
- Updated: 2026-09-02

Your API key must never reach a browser, so the browser talks to your app and your app talks to us. In Next.js that is one file.

### The server half

App Router, mounted at a catch-all so every operation reaches the handler. The `[...path]` segment is not decoration — without it the route only ever matches the mount path itself and answers 404 for `connect`, `end`, `avatars` and `credits` alike.

**Next.js**

```tsx
// app/api/realtime-avatar/[...path]/route.ts
import { createRealtimeAvatarRoute } from "realtime-avatar/nextjs";

export const { GET, POST } = createRealtimeAvatarRoute({
  apiKey: process.env.REALTIME_AVATAR_API_KEY!,

  // Who may do this. Return a Response to refuse, or nothing to allow.
  // "connect" is the only operation that costs money to start, so that is
  // where the wallet check belongs; the reads stay cheap.
  authorize: async ({ request, operation }) => {
    const user = await currentUser(request);
    if (!user) return new Response("Sign in", { status: 401 });
    if (operation === "connect" && !user.credits) {
      return Response.json({ code: "insufficient_credits" }, { status: 402 });
    }
  },

  // What the character knows. Decided HERE — the client sends none of it.
  session: async ({ avatarId }) => ({
    instructions: promptFor(avatarId),
  }),
});
```

Name the variable **without** `NEXT_PUBLIC_`. That prefix is what inlines a value into the client bundle, so a key wearing it ships to every visitor — the one mistake this whole split exists to prevent.

### The client half

One component, pointed at the route you just mounted. It is the same component on every framework — see [React](https://realtimeavatar.ai/docs/react) for the hook underneath it and for controlling the call yourself.

**Next.js**

```tsx
"use client";
import { AvatarCall, createProxyClient } from "realtime-avatar/react";

const client = createProxyClient({ proxyUrl: "/api/realtime-avatar" });

export function Call({ avatarId }: { avatarId: string }) {
  return <AvatarCall client={client} avatarId={avatarId} />;
}
```

`"use client"` is required: the call holds a WebRTC room and browser media, none of which exist in a server component.

### Next

- [Authentication](https://realtimeavatar.ai/docs/authentication) — keys, scopes, and what `authorize` is really gating.
- [Calls](https://realtimeavatar.ai/docs/sessions) — everything the `session` policy can decide.

## TanStack Start

Source: https://realtimeavatar.ai/docs/tanstack-start (markdown: https://realtimeavatar.ai/docs/tanstack-start.md, updated 2026-09-02)

> Mount the realtime avatar proxy in a TanStack Start app: a splat server route on the server, one component in the browser.

- Canonical: https://realtimeavatar.ai/docs/tanstack-start
- Updated: 2026-09-02

Your API key must never reach a browser, so the browser talks to your app and your app talks to us. In Start that is one server route.

### The server half

Mount at `routes/api/realtime-avatar/$.ts`. The trailing `$` is Start's splat segment and it is **load-bearing**: without it the handler only ever sees the mount path itself and answers 404 for every operation — the same trap Next.js's `[...path]` exists to avoid.

**TanStack Start**

```tsx
// routes/api/realtime-avatar/$.ts
import { createFileRoute } from "@tanstack/react-router";
import { realtimeAvatarServerRoute } from "realtime-avatar/tanstack-start";

export const Route = createFileRoute("/api/realtime-avatar/$")({
  server: {
    handlers: realtimeAvatarServerRoute({
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
  },
});
```

On Cloudflare Workers there is no `process.env`, so pass `apiKey` as a **factory** — `apiKey: () => getEnv().REALTIME_AVATAR_API_KEY` — and it is read per request instead of at module scope.

### The client half

**TanStack Start**

```tsx
import { AvatarCall, createProxyClient } from "realtime-avatar/react";

const client = createProxyClient({ proxyUrl: "/api/realtime-avatar" });

export function Call({ avatarId }: { avatarId: string }) {
  return <AvatarCall client={client} avatarId={avatarId} />;
}
```

### Next

- [Authentication](https://realtimeavatar.ai/docs/authentication) — keys, scopes, and what `authorize` is really gating.
- [Calls](https://realtimeavatar.ai/docs/sessions) — everything the `session` policy can decide.

## Express

Source: https://realtimeavatar.ai/docs/express (markdown: https://realtimeavatar.ai/docs/express.md, updated 2026-09-02)

> Mount the realtime avatar proxy as Express middleware — Express 4 or 5 — with the same authorize and session policy every adapter takes.

- Canonical: https://realtimeavatar.ai/docs/express
- Updated: 2026-09-02

Your API key must never reach a browser, so the browser talks to your app and your app talks to us. In Express that is one middleware.

### The server half

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

### The client half

Express serves your API; the browser half is the same component as everywhere else, pointed at the prefix you mounted.

**React**

```tsx
import { AvatarCall, createProxyClient } from "realtime-avatar/react";

const client = createProxyClient({ proxyUrl: "/api/realtime-avatar" });

<AvatarCall client={client} avatarId={avatarId} />
```

If your React app is served from a different origin than the Express API, give `proxyUrl` the absolute URL and allow credentials in your CORS policy — the proxy is your endpoint, so its auth is your session, not ours.

### Next

- [Authentication](https://realtimeavatar.ai/docs/authentication) — keys, scopes, and what `authorize` is really gating.
- [Calls](https://realtimeavatar.ai/docs/sessions) — everything the `session` policy can decide.

## Hono, Workers, Bun and Deno

Source: https://realtimeavatar.ai/docs/hono (markdown: https://realtimeavatar.ai/docs/hono.md, updated 2026-09-02)

> Mount the realtime avatar proxy on any Fetch-handler runtime — Hono, Cloudflare Workers, Bun or Deno — including the apiKey factory Workers require.

- Canonical: https://realtimeavatar.ai/docs/hono
- Updated: 2026-09-02

This adapter is for Hono and for anything else built on Fetch handlers — Cloudflare Workers, Bun, Deno. It takes a `Request` and returns a `Response`, which is why one adapter covers all four.

### The server half

Mount on a wildcard so every operation reaches the handler, not just the mount path.

**Hono**

```ts
import { Hono } from "hono";
import { realtimeAvatarHono } from "realtime-avatar/hono";

const app = new Hono<{ Bindings: Env }>();

app.all(
  "/api/realtime-avatar/*",
  realtimeAvatarHono({
    // A FACTORY, not a value. On Workers there is no process.env, and a
    // module-scope read runs before any binding exists.
    apiKey: () => env.REALTIME_AVATAR_API_KEY,

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

export default app;
```

On Node or Bun, where `process.env` exists, a plain string is fine: `apiKey: process.env.REALTIME_AVATAR_API_KEY!`. The factory form is what makes the Workers case work, and it is harmless everywhere else — the value is simply read per request instead of once at module scope.

### The client half

**React**

```tsx
import { AvatarCall, createProxyClient } from "realtime-avatar/react";

const client = createProxyClient({ proxyUrl: "/api/realtime-avatar" });

<AvatarCall client={client} avatarId={avatarId} />
```

### Next

- [Authentication](https://realtimeavatar.ai/docs/authentication) — keys, scopes, and what `authorize` is really gating.
- [Calls](https://realtimeavatar.ai/docs/sessions) — everything the `session` policy can decide.

## React and React Native

Source: https://realtimeavatar.ai/docs/react (markdown: https://realtimeavatar.ai/docs/react.md, updated 2026-09-02)

> The browser half: the AvatarCall component, the useAvatarCall hook underneath it, and what changes on React Native.

- Canonical: https://realtimeavatar.ai/docs/react
- Updated: 2026-09-02

Every server adapter mounts the same proxy, so the client half is the same everywhere: one component pointed at your route.

### The component

**React**

```tsx
import { AvatarCall, createProxyClient } from "realtime-avatar/react";

const client = createProxyClient({ proxyUrl: "/api/realtime-avatar" });

<AvatarCall client={client} avatarId={avatarId} />

// Audio only — no video track is requested, so nothing renders and
// nothing decodes.
<AvatarCall client={client} avatarId={avatarId} mode="voice" />
```

### The hook underneath it

`AvatarCall` is a default surface over `useAvatarCall`. Reach for the hook when you want the call's state but your own layout — a custom control bar, your own video element, a call that lives inside something else.

**React**

```tsx
import { createProxyClient, useAvatarCall } from "realtime-avatar/react";

const client = createProxyClient({ proxyUrl: "/api/realtime-avatar" });

function MyCall({ avatarId }: { avatarId: string }) {
  const call = useAvatarCall({ client, avatarId });
  // Drive your own UI from the call's state, and render its video surface
  // wherever your layout wants it.
}
```

Nothing opens a session until you ask it to. A mounted component that has not connected costs nothing — sessions are metered per second on air, so the connect is always an explicit act.

### React Native

A separate entry point, because the media stack is not the browser's: it wraps LiveKit's React Native room and needs an audio session the OS has granted.

**React Native**

```tsx
import {
  RealtimeAvatarLiveKitRoom,
  AvatarVideoSurface,
  useRealtimeAvatarAudioSession,
} from "realtime-avatar/react-native";

// Own the OS audio session while the call is up, or the room connects
// with no microphone and the call is one-way. The argument IS the
// lifecycle: pass your connected state, not `true`, so the session is
// released when the call ends.
useRealtimeAvatarAudioSession(connected);
```

`registerGlobals` from the same entry point must run once at app start — it installs the WebRTC globals React Native does not ship.

### Next

- Mount the server half: [Next.js](https://realtimeavatar.ai/docs/nextjs), [TanStack Start](https://realtimeavatar.ai/docs/tanstack-start), [Express](https://realtimeavatar.ai/docs/express), or [Hono and Workers](https://realtimeavatar.ai/docs/hono).
- [Calls](https://realtimeavatar.ai/docs/sessions) — what the server decides on every connect.
