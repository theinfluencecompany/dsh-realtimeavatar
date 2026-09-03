---
name: realtimeavatar-quickstart
description: Realtime Avatar (realtimeavatar.ai) from zero to a live call: what the product is, plans and credits, creating an API key (tic_live_/tic_test_, scopes, spend cap), keeping it server-side as REALTIME_AVATAR_API_KEY, and the quickstart on the public example avatar seed-rin-ashfall. Load before helping someone sign up, get a key, or make a first call.
snapshot: 2026-09-03
sources: docs.md, docs/quickstart.md, docs/authentication.md
---

> Snapshot of the public documentation at https://realtimeavatar.ai taken on 2026-09-03. For the current text of any page call the `rta_docs` tool; the canonical pages are linked under every section.

## Key facts (verified 2026-09-03)

- Sign up: https://realtimeavatar.ai/signup · dashboard: https://realtimeavatar.ai/platform/dashboard · API keys: https://realtimeavatar.ai/platform/settings#api-keys · pricing: https://realtimeavatar.ai/pricing
- Keys look like tic_live_… or tic_test_… and are shown once. The tag is organisational, not a sandbox: both spend the same credits. Dashboard keys start with every scope except `*`; untick what a key should not do; set a per-key spend limit when handing a key to a subsystem.
- Env var: REALTIME_AVATAR_API_KEY on the server only (never NEXT_PUBLIC_/VITE_). In dsh the harness holds it: `/rta key tic_…`, `/rta status`.
- SDK: `npm install realtime-avatar` (public npm, MIT; pin an exact version). No Python SDK — the backend half is plain HTTP.
- Public example avatar: `seed-rin-ashfall` — any key can mint a call against it, so a first app never waits on creating an avatar.
- Credits: 1 credit = 1 second on air; live conversation lands around $5/hour.

| Plan | $/mo | Credits | ≈ minutes | Concurrent streams | Avatars | Note |
|---|---|---|---|---|---|---|
| Sandbox | 0 | 1,020 | 17 | 1 | 1 | no card; enough for a first avatar plus a few minutes of calls |
| Starter | 9 | 7,200 | 120 | 2 | 5 | overage $0.095/min |
| Developer | 24 | 36,000 | 600 | 5 | 25 | overage $0.085/min |
| Studio | 119 | 180,000 | 3000 | 20 | 100 | overage $0.08/min; experimental features |

| Scope | Grants |
|---|---|
| `realtime:write` | Start and end calls |
| `avatars:read` | List and fetch avatars and assets |
| `avatars:write` | Create and update avatars, upload assets, sync clips |
| `credits:read` | Read the balance |
| `usage:read` | Usage reporting (read) |
| `usage:write` | Usage reporting (write) |
| `api_keys:write` | Mint further keys — untick unless a back-office job needs it |
| `*` | Everything, including scopes added later — avoid outside trusted back-office jobs |

### The public "build my first app" prompt (hand it to a coding agent)

```text
Build a one-button page that opens a live video call with the example avatar Rin (seed-rin-ashfall): she speaks first, two-way voice, her portrait while she connects, a hang-up button. Stop there for testing. Key in REALTIME_AVATAR_API_KEY. Follow https://realtimeavatar.ai/llms.txt.

Optional — to use your own avatar instead: create Nova from nova.png with a warm mid-pitch voice, poll until ready, and repoint the same button at her without changing the page.
```

## Realtime Avatar API

Source: https://realtimeavatar.ai/docs (markdown: https://realtimeavatar.ai/docs.md, updated 2026-08-27)

> Put a live character in your product, on a voice or video call, with your own tools wired into the conversation.

- Canonical: https://realtimeavatar.ai/docs
- Updated: 2026-08-27

### Voice or video, on one meter

**TypeScript**

```tsx
<AvatarCall client={client} avatarId={avatarId} />                 // she is on screen
<AvatarCall client={client} avatarId={avatarId} mode="voice" />   // audio only
```

**Python**

```python
body = {"avatar_id": avatar_id, "mode": "avatar"}   # she is on screen
body = {"avatar_id": avatar_id, "mode": "voice"}    # audio only
```

**It is priced to leave on.** Live conversation meters at **about $5 an hour** — $4.20 to $5.70 depending on plan — with a free tier to build against. That is the difference between a demo you show and a feature you ship: a companion app can afford to let someone talk.

How she is rendered is in [Creating an avatar](https://realtimeavatar.ai/docs/video).

### She listens while she talks

Most voice AI takes turns like a walkie-talkie: you talk, you stop, it answers. This one is full-duplex — she is hearing you the whole time she is speaking — and in practice that shows up as four things you do not have to build:

- **Interrupt her and she stops**, mid-sentence, and can acknowledge it in character rather than snapping to silence.
- **A cough or an "mm-hm" does not derail her.** A backchannel is not an interruption, and being cut off by one is what makes a system feel brittle.
- **A pause is not the end of your turn.** Whether you are finished is judged by what you said, not by how long you have been quiet — so she neither talks over you nor leaves a gap.
- **Silence and language switches are handled.** Going quiet is a signal she can act on, and she follows a language change inside a single sentence.

Nothing to configure — it is how every call behaves. The one limit worth knowing: she will not talk over you with a new sentence while you are speaking. That is a deliberate trade for the voice and model choices this platform is built on.

### Your tools, wired into the conversation

A character that can only talk is a demo. The useful version books the appointment, checks the order, writes the code and keeps talking while it runs.

You declare a tool the same way you would brief a colleague: what it is called, and *when to reach for it*. The description is the whole teaching signal — she reads it and decides.

**TypeScript**

```ts
import type { AvatarTool } from "realtime-avatar/tools";

export const checkOrder: AvatarTool<{ order_id: string }> = {
  description:
    "Look up the status of a customer's order. Call this whenever they ask " +
    "where something is, or when it will arrive.",
  parameters: {
    type: "object",
    properties: { order_id: { type: "string" } },
    required: ["order_id"],
  },
  execute: async ({ order_id }, { signal }) => {
    const order = await api.order(order_id, { signal });
    return `${order.status}, arriving ${order.eta}.`;
  },
};
```

**Python**

```python
# Tools run in the page that renders the call — there is no hosted execution,
# so there is nothing to declare in Python. Your backend's part is the GRANT:
body["capabilities"] = ["client_tools"]

# The mint schema is strict: a tools[] field on the request itself is a 422.
# The page registers the manifest over RPC once the room is connected.
```

Then your server grants the tool plane at mint, and the page registers the tools once the room is connected. Omitting `execute` is a compile error rather than a timeout you find in production — and a tool has **2.5 seconds** to answer, so anything slow acknowledges fast and delivers the real result out of band:

**TypeScript**

```ts
// server — the session policy grants the client tool plane for this call
session: async ({ avatarId }) => ({ instructions, clientTools: true })

// client — register over RPC after connect; the record key is the tool's name
import { attachAvatarTools } from "realtime-avatar/tools";

const { accepted, rejected } = await attachAvatarTools(room, {
  check_order: checkOrder,
});
```

**Python**

```python
# server — grant the capability on the mint. That is the whole backend part:
body["capabilities"] = ["client_tools"]

# The worker only exposes tool registration to a session minted with the
# capability. If the page reports the registration method is missing, the fix
# is HERE, not in the page.
```

Full pattern: [Tool calling](https://realtimeavatar.ai/docs/tool-calling).

> The `createRealtimeAvatarRoute` and `AvatarCall` surface described here needs `realtime-avatar@0.6.0` or newer. On an older install those exports do not exist and the compiler will say so — update the package rather than working around it.

### Where to go next

- [Quickstart](https://realtimeavatar.ai/docs/quickstart) — key to live call in three steps.
- [Calls](https://realtimeavatar.ai/docs/sessions) — the policy your server decides, the five states, ending gracefully.
- [Creating an avatar](https://realtimeavatar.ai/docs/video) — one image in; the platform generates the loop and a map of states it switches between, or synthesizes the video live.
- [Tool calling](https://realtimeavatar.ai/docs/tool-calling) — running your own agent loop against a live character.
- [API reference](https://realtimeavatar.ai/docs/api-reference) — every endpoint, scope, and error.

## Quickstart

Source: https://realtimeavatar.ai/docs/quickstart (markdown: https://realtimeavatar.ai/docs/quickstart.md, updated 2026-09-02)

> From an API key to a live avatar call in three steps: get a key, build the app on an example avatar, then swap in a character of your own.

- Canonical: https://realtimeavatar.ai/docs/quickstart
- Updated: 2026-09-02

Three steps. Your first call runs on a public example avatar, so nothing is blocked on creating one — and the app is one step, not two: a server half that holds the key and a client half that renders. The SDK ships both.

### 1. Get a key and install the SDK

Create a key in the [dashboard](https://realtimeavatar.ai/platform/dashboard) — it looks like `tic_live_…` or `tic_test_…` and is shown once. It arrives with every scope enabled, so nothing 403s on your first call — untick the ones this key should not have.

The SDK is on npm — no registry configuration, no auth token:

**TypeScript**

```bash
npm install realtime-avatar
```

Self-contained: the contracts package is bundled into the build, so there is no private dependency to resolve. Pin an exact version for reproducible CI.

**Python**

```bash
pip install httpx
```

There is no Python SDK — the live call is rendered by a browser or native client, so Python's half is plain HTTP and one dependency.

### 2. Build the app on an example avatar

An app is two halves and the SDK ships both: a connect endpoint on your server, and one component in the browser. Hand this whole step to a coding agent if you would rather not type it — the prompt is on your key in [settings](https://realtimeavatar.ai/platform/settings#api-keys).

#### The server half — the connect endpoint

Your API key must never reach a browser, so the browser talks to your app and your app talks to us. One function is that endpoint — it decides **who** may start a call and **what** the character knows when they do:

**Next.js**

```tsx
// app/api/realtime-avatar/[...path]/route.ts
import { createRealtimeAvatarRoute } from "realtime-avatar/nextjs";

export const { GET, POST } = createRealtimeAvatarRoute({
  apiKey: process.env.REALTIME_AVATAR_API_KEY!,

  // Who may do this. "connect" is the only operation that costs money to start,
  // so that is where the wallet check belongs; the reads stay cheap.
  authorize: async ({ request, operation }) => {
    const user = await currentUser(request);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (operation === "connect" && !(await hasCredits(user))) {
      return Response.json({ code: "insufficient_credits" }, { status: 402 });
    }
  },

  // What the character knows for THIS call. Whatever the browser sent for these
  // concerns is discarded — this callback is the only source.
  session: async ({ request, avatarId, mode }) => {
    const user = await currentUser(request);
    const character = await db.character(avatarId);
    return {
      instructions: character.prompt,
      context: await db.recentTurns(user.id, avatarId),
      maxSeconds: secondsTheBalanceAffords(user, mode),
    };
  },
});
```

The catch-all segment matters — the route answers four paths under one prefix (`POST /connect`, `POST /end`, `GET /avatars`, `GET /credits`), so a single `[...path]` segment serves all of them.

**TanStack Start**

```tsx
// src/routes/api/realtime-avatar/$.ts
import { createFileRoute } from "@tanstack/react-router";
import { realtimeAvatarServerRoute } from "realtime-avatar/tanstack-start";

const handlers = realtimeAvatarServerRoute({
  apiKey: process.env.REALTIME_AVATAR_API_KEY!,
  authorize: async ({ request, operation }) => {
    const user = await requireUser(request);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (operation === "connect" && !(await hasCredits(user))) {
      return Response.json({ code: "insufficient_credits" }, { status: 402 });
    }
  },
  session: async ({ request, avatarId, mode }) => {
    const user = await requireUser(request);
    const character = await loadCharacter(avatarId);
    return {
      instructions: buildPrompt(character),
      context: await loadRecentTurns(user.id, avatarId),
      maxSeconds: secondsTheBalanceAffords(user, mode),
    };
  },
});

export const Route = createFileRoute("/api/realtime-avatar/$")({
  server: { handlers },
});
```

The trailing `$` is Start's splat segment — without it the handler only ever sees the mount path and answers 404. Build the handlers once at module scope. On Cloudflare Workers pass a factory — `apiKey: () => getEnv().KEY` — since there is no `process.env`.

**Python**

```python
# Your backend decides; the browser renders. Same split, no SDK needed.
import os, httpx
from fastapi import Depends, FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

BASE = "https://realtimeavatar.ai/api/v1"
client = httpx.Client(base_url=BASE, timeout=30.0, headers={
    "Authorization": f"Bearer {os.environ['REALTIME_AVATAR_API_KEY']}"})

app = FastAPI()

class StartCallRequest(BaseModel):
    avatar_id: str
    mode: str = "avatar"                          # "avatar" | "voice"
    queue_ticket_id: str | None = None            # a client retrying after a 429 hands its ticket back

@app.post("/api/calls")
def start_call(req: StartCallRequest, user=Depends(current_user)):
    if not has_credits(user):
        return JSONResponse({"code": "insufficient_credits"}, 402)

    character = load_character(req.avatar_id)
    seconds = int(seconds_the_balance_affords(user, req.mode))   # wire: int, 1..1800
    body = {
        "avatar_id": character.avatar_id,
        "mode": req.mode,
        "stt_mode": "server",
        # Decided HERE. The client sends none of this.
        "instructions": build_prompt(character),
        # ≤32 of exactly {"role": "system" | "user" | "assistant", "content": 1..4000 chars} —
        # strict: any other key is a 422
        "initial_context": [{"role": t.role, "content": t.text}
                            for t in recent_turns(user.id, character.avatar_id)][-32:],
        "max_session_seconds": max(1, min(seconds, 1800)),
        # Optional: a signed POST of the transcript when the call ends (receiver: Tool calling).
        "transcript_webhook": {"url": "https://your.app/api/rta/transcript",   # https only
                               "secret": os.environ["TRANSCRIPT_SECRET"]},     # 16..200 chars
        "client_metadata": {"user_id": str(user.id),                           # ≤16 string pairs,
                            "character_id": character.avatar_id},              # echoed back to you
    }
    if req.queue_ticket_id:
        body["queue_ticket_id"] = req.queue_ticket_id

    r = client.post("/realtime/livekit/session", json=body)
    data = r.json()
    if r.status_code == 429 and "queue_ticket_id" in data:
        # Every slot busy — the queue, not an error. Relay it VERBATIM: the busy body
        # carries queue_ticket_id (the only handle that RELEASES the slot when the
        # caller gives up) and recommended_retry_ms (when to come back). The client
        # retries WITH the ticket; reshaping this strands it for its whole TTL.
        return JSONResponse(data, 429)
    if not r.is_success:
        # 402 / 409 / 422 — and the 429s that are NOT the queue (plan concurrency
        # ceiling, rate limit). Forward {error, code?}, but not at 429: an SDK
        # client reads every 429 as the queue.
        return JSONResponse(data, 503 if r.status_code == 429 else r.status_code)
    return data                                   # return this VERBATIM
```

Two rules when hand-rolling. First, casing is **per endpoint**, and every endpoint is strict — an unknown or mis-cased key is a rejected call. The two realtime routes shown here (`/realtime/livekit/session` and its `/release`) are **snake_case**; every REST resource endpoint — avatars, clips, keys, assets — is **camelCase**. Measured against the published spec: 2 of the 9 request bodies are snake_case at the top level and the other 7 are camelCase — except `POST /avatars`, which is camelCase outside and snake_case inside `voice` (`auto_description`, `voice_id`), as the sample above shows. And the SDK's policy names are not the wire names: `context` is `initial_context`, `maxSeconds` is `max_session_seconds`, `transcript` is `transcript_webhook`, `metadata` is `client_metadata`. Second, if your client uses this SDK the response must reach it **byte-for-byte** — the SDK hands the body to the room unvalidated, so a wrapped grant never connects: the token and URL read as undefined and the call sits in `connecting` with no error. A client driving the room directly reads only the fields it needs and tolerates extras, but relaying verbatim keeps both paths working. The same goes for a busy `429`: it is the queue only when the body carries `queue_ticket_id`, and a retry that does not present that ticket mints a fresh one every poll — its position never advances.

Everything in `session` is authoritative: whatever the browser sends for the persona, the memory, the voice, or the time limit is discarded before the request leaves your server. A field your policy does not set is absent rather than inherited, so an omission fails closed rather than open.

`maxSeconds` is the one to get right on day one — it is what stops a call your balance cannot cover. See [Authentication](https://realtimeavatar.ai/docs/authentication) for the full list of what belongs on the server and why.

#### The client half — render the call

Build the client once, then render one component. It handles the queue, reconnects, the idle timer, and the video surface for you. Pass a public example avatar id to`avatarId` — `seed-rin-ashfall` is one — and this call is live before you have created anything; step 3 swaps in your own:

An example avatar serves its own still and idle loop, so the surface has something to show before the first frame arrives. A catalog row with no `idleVideoUrl` is a stream-only host published for one of the live channels; a call to one is refused with 409, so call an id whose row carries an idle loop. The two below are `seed-rin-ashfall`’s. **Both props are optional and the filenames are not a scheme** — they differ from character to character, so copy the pair that belongs to the avatar you are using rather than deriving them from its name. Point `poster` and `idleVideoUrl` at them and the page is never empty: she is on screen while the call is still connecting.

**React**

```tsx
import { AvatarCall, createProxyClient } from "realtime-avatar/react";

const client = createProxyClient({ proxyUrl: "/api/realtime-avatar" });

export function Call({ avatarId }: { avatarId: string }) {
  return (
    <AvatarCall
      client={client}
      avatarId={avatarId}
      idleVideoUrl="https://realtimeavatar.ai/api/assets/public/characters/rin-ashfall/idle-10s.mp4"
      poster="https://realtimeavatar.ai/api/assets/public/characters/rin-ashfall/portrait.png"
      onEnded={({ reason }) => showEndScreen(reason)}
    >
      {(call) =>
        call.status === "waiting" ? <Banner>In line: {call.queuePosition}</Banner> : null
      }
    </AvatarCall>
  );
}
```

Live media needs the DOM. In Next.js mark the file `"use client"` and import it with `{ ssr: false }`; in TanStack Start gate it on a mounted flag or load it lazily.

**React Native**

```tsx
import {
  AvatarVideoSurface,
  RealtimeAvatarLiveKitRoom,
  SessionLifecycleRoomBridge,
  createProxyClient,
  registerGlobals,
  useSessionLifecycle,
} from "realtime-avatar/react-native";

registerGlobals();                                  // once, at app startup

// Native has no page origin — the proxy URL must be ABSOLUTE.
const client = createProxyClient({
  proxyUrl: "https://your-app.example.com/api/realtime-avatar",
});

export function Call({ avatarId }: { avatarId: string }) {
  const lifecycle = useSessionLifecycle({ client, session: { avatarId } });
  if (!lifecycle.grant) return null;                // map lifecycle.phase to your UI

  return (
    <RealtimeAvatarLiveKitRoom
      grant={lifecycle.grant}
      onConnected={lifecycle.onConnected}
      onDisconnected={lifecycle.onDisconnected}
      onError={lifecycle.onConnectionError}
    >
      <SessionLifecycleRoomBridge lifecycle={lifecycle} />
      <AvatarVideoSurface
        idleVideoUrl={idleClipUrl}
        poster={posterUrl}
        // Native has no <video> — hand the idle clip to YOUR player, looped and muted.
        renderIdleVideo={({ url, style }) => <IdleClip url={url} style={style} />}
      />
    </RealtimeAvatarLiveKitRoom>
  );
}
```

**Native is the lower-level surface today.** `<AvatarCall>` is web-only — the session brain is the same module, but you compose the native room and video surface yourself, and you pick the video player (`expo-video`, `react-native-video`). Live media does not run in Expo Go; you need a dev client or an EAS build.

`status` is five values — `connecting` · `waiting` · `live` · `recovering` · `ended` — and you write the copy for the ones you care about. The SDK ships no strings.

The `children` render prop hands you a `call` handle: `say()`, `sayAndEnd()`, `keepAlive()`, `end()`, and `secondsRemaining`. Want your own layout around the video rather than on top of it? `useAvatarCall()` returns `{ call, view }` so you can place the view anywhere.

**React Native** runs the same session brain with native media — `useSessionLifecycle`, the grant and queue handling, and the quality governor are the identical modules; only the room bridge and the video surface are native twins. Import from `/react-native`, call `registerGlobals()` at startup, and pass an absolute `proxyUrl` (native has no page origin). The one-component `<AvatarCall>` wrapper is web-only for now.

### 3. Make the character yours

The example avatars get you a working call; your own character is one create call away, and nothing above changes but the id. An avatar is one portrait image plus a voice. Upload the image and the platform does the rest **in the background**: it generates the looping idle video and a small motion library — an idle variant, a listening state, a gesture — from that single frame. From a trusted server:

**TypeScript**

```ts
import { RealtimeAvatar } from "realtime-avatar";

const rta = new RealtimeAvatar({ apiKey: process.env.REALTIME_AVATAR_API_KEY! });

// Upload the portrait, then create the avatar from it.
const asset = await rta.uploadAsset(portraitBlob, { kind: "image", filename: "rin.png" });

const avatar = await rta.createAvatar({
  displayName: "Rin",
  sourceKind: "image",                    // one frontal portrait: jpeg/png/webp, up to 8MB
  sourceAssetId: asset.id,
  voice: { auto_description: "Warm, clear, mid-pitch — natural and conversational." },
});

console.log(avatar.id);      // ava_…
console.log(avatar.status);  // "preprocessing" — generation has started
```

**Python**

```python
import os, time, httpx

client = httpx.Client(
    base_url="https://realtimeavatar.ai/api/v1", timeout=60.0,
    headers={"Authorization": f"Bearer {os.environ['REALTIME_AVATAR_API_KEY']}"})

# Register the portrait, then create the avatar from it.
asset = client.post("/assets/remote", json={
    "kind": "image",
    "remoteUrl": "https://cdn.example.com/rin/portrait.png",
}).json()

avatar = client.post("/avatars", json={
    "displayName": "Rin",
    "sourceAssetId": asset["id"],
    "voice": {"auto_description": "Warm, clear, mid-pitch — natural and conversational."},
}).json()

print(avatar["id"])      # ava_…
print(avatar["status"])  # "preprocessing" — generation has started
                         # ("failed" + avatar["error"] if it could not be queued)

# Poll until the loop and clips have rendered — a minute or two.
while avatar["status"] == "preprocessing":
    time.sleep(15)
    avatar = client.get(f"/avatars/{avatar['id']}").json()
print(avatar["status"])  # "ready" — mint calls; "failed" — avatar["error"] says why
```

> **Creation is asynchronous.** The create call returns in milliseconds with `status: "preprocessing"`; the idle loop and the clip library render in the background over the next minute or two. Poll `getAvatar(id)` (`GET /avatars/{id}` on the wire) until `status` is `ready` before minting a call. Before the loop attaches a mint is refused with a clear error — never a broken call.

**Why a `failed` status happened is not on the SDK object.** `getAvatar()` returns the five fields an integration branches on — `id`, `displayName`, `sourceKind`, `status`, `defaultVoiceId` — and nothing else. The wire's `GET /avatars/{id}` carries the diagnostics on top of those: `error` (the reason a `failed` avatar failed) and `idleVideoStatus` (how far the loop got). Read those with a plain authenticated fetch when you are showing a human what went wrong. And do not branch on `sourceKind` to tell a finished avatar from a fresh one: once the generated loop attaches it reads `video`, and `sourceAssetId` names the loop now serving rather than the portrait you uploaded (that is `anchor.url` on `GET /avatars/{id}/clips`). Gate on `status` — or `idleVideoStatus` — never on `sourceKind == "image"`.

`motionPrompt` optionally art-directs the generated loop ("soft cafe light, gentle idle energy") — set it as **Resting motion direction** on the [Avatars page](https://realtimeavatar.ai/platform/avatars) or on the wire's `POST /avatars`; omit it for the house default. Once `ready`, `GET /avatars/{id}/clips` lists the generated motion library — render calls inherit it automatically. The Avatars page's **Clips** action provides the same full-library declaration flow for generated prompt clips when the workspace rollout is enabled.

`voice: { auto_description }` lets the platform pick the best-matching Fish Audio voice from your description; pass `voice: { voice: { provider, voice_id } }` to choose one explicitly — an explicit voice is nested under `voice.voice` (in Python, `"voice": {"voice": {"provider": "fish", "voice_id": "…"}}`); a top-level `voice: { provider, voice_id }` is a `422`. Omit `voice` entirely to keep the avatar's current default.

You can also do all of this on the [Avatars page](https://realtimeavatar.ai/platform/avatars) with no code — see [Creating an avatar](https://realtimeavatar.ai/docs/video). Either way you end up with an `ava_…` id, which is the only thing your client needs to know.

**Build from an image.** One portrait in, every piece of video generated by the platform — that is the path these docs describe. An image source queues the motion generation above: the avatar sits in `preprocessing` until the idle loop and the clip library are rendered, and only then does it mint calls.

**There is no other lane.** `sourceKind: "video"` — registering a looping clip you host — is closed to new callers and answers `422`. (That is the field you send on create; a ready image-built avatar reads `sourceKind: "video"` too, because the loop the platform generated is now its source.) An avatar is built from one portrait and the platform renders the idle loop and every motion clip from it; that shared rest pose is what makes a state switch a splice instead of a jump, and a supplied video cannot honour it. Tenants already creating from video keep working, and their existing avatars are untouched — the door is shut for new integrations, not behind anyone.

> **Your editor may still suggest `createAvatarFromVideo()`.** It is on its way out and its doc comment is older still — it warns that an image-sourced avatar publishes a black track, which stopped being true when image-only creation shipped. Use `createAvatarFromImage()`.

### That is the whole surface

Two calls: `createRealtimeAvatarRoute` on the server, `AvatarCall` on the client. You never touch the transport, the reconnect logic, or a wire format — and because you never touch them, we can change them underneath you without breaking your app.

If you do want that control — your own media policy, your own transport handling — every lower-level primitive is still exported and still supported. Most teams never need to.

### What to read next

- [Calls](https://realtimeavatar.ai/docs/sessions) — the policy your server decides, the five states, and how to end a call without cutting her off mid-sentence.
- [Tool calling](https://realtimeavatar.ai/docs/tool-calling) — if your character needs to actually do things.

## Authentication

Source: https://realtimeavatar.ai/docs/authentication (markdown: https://realtimeavatar.ai/docs/authentication.md, updated 2026-08-27)

> Get a key, keep it on your server, and decide who may start a call.

- Canonical: https://realtimeavatar.ai/docs/authentication
- Updated: 2026-08-27

### Keys

Create one in the [dashboard](https://realtimeavatar.ai/platform/dashboard). It is shown once, and it goes in a bearer header:

```text
Authorization: Bearer tic_live_…
```

Keys are environment-tagged — `tic_test_…` for development, `tic_live_…` for production — and each one can carry its own spend limit, which is useful when handing a key to a subsystem you would rather cap. The cap is enforced against the wallet, so it does nothing on a workspace billed as **unlimited**: that account never consults a balance, and the per-key check sits behind the one it skips. The limit is still accepted and echoed back, so if you are on an unlimited plan, treat a per-key cap as a note to yourself rather than a control.

**The tag is organisational, not a sandbox.** It picks the prefix and nothing else: a `tic_test_…` key mints real sessions on the same fleet and bills the same credits against the same balance as a `tic_live_…` one. Nothing about your account is different in "test". That is worth saying plainly, because the naming is the one most APIs use for a free, isolated test mode, and it is not that here — the way to develop without spending production credits is a separate workspace, or a per-key `spendLimitCreditMicros` low enough to fail closed.

#### Scopes

You pick these at creation. A key made in the dashboard starts with every scope enabled except `*`, so it works straight away — untick whatever this key has no business doing, particularly `api_keys:write`. Creating one over the API instead and omitting `scopes` gives you the narrower `realtime:write`, `avatars:read`, `credits:read`.

| Scope | Grants |
| --- | --- |
| `realtime:write` | Start and end calls |
| `avatars:read` | List and fetch avatars and assets |
| `avatars:write` | Create and update avatars, upload assets, sync clips |
| `credits:read` | Read the balance |
| `usage:read` · `usage:write` | Usage reporting |
| `api_keys:write` | Mint further keys |
| `*` | Everything — avoid outside trusted back-office jobs |

### The one rule: the key stays on your server

A browser holding the key could start unlimited calls on your account, so it never gets one. Your client talks to your app; your app talks to us. That is what the route adapters are — `createRealtimeAvatarRoute` and its siblings — mount one and `authorize` is your gate:

**Next.js**

```tsx
import { createRealtimeAvatarRoute } from "realtime-avatar/nextjs";

export const { GET, POST } = createRealtimeAvatarRoute({
  apiKey: process.env.REALTIME_AVATAR_API_KEY!,   // never NEXT_PUBLIC_ prefixed

  authorize: async ({ request, operation }) => {
    const user = await currentUser(request);
    if (!user) return new Response("Unauthorized", { status: 401 });

    // "connect" is the only operation that costs money to START.
    if (operation === "connect" && !(await hasCredits(user))) {
      return Response.json({ code: "insufficient_credits" }, { status: 402 });
    }
  },
});
```

**TanStack Start**

```tsx
import { realtimeAvatarServerRoute } from "realtime-avatar/tanstack-start";

const handlers = realtimeAvatarServerRoute({
  apiKey: () => getEnv().REALTIME_AVATAR_API_KEY,  // a factory works on Workers

  authorize: async ({ request, operation }) => {
    const user = await requireUser(request);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (operation === "connect" && !(await hasCredits(user))) {
      return Response.json({ code: "insufficient_credits" }, { status: 402 });
    }
  },
});
```

**Python**

```python
# No handler to mount — your own endpoint is the gate.
from fastapi import Depends, HTTPException
from fastapi.responses import JSONResponse

@app.post("/api/calls")
def start_call(req: StartCallRequest, user=Depends(current_user)):
    if not user:
        raise HTTPException(401)
    if not has_credits(user):                 # starting a call is the costly one
        # HTTPException would nest this under "detail"; keep code top-level.
        return JSONResponse({"code": "insufficient_credits"}, 402)
    ...
```

Return a `Response` to refuse, or nothing to allow. There are four operations: `connect`, `end`, `avatars`, and `credits`. Put your wallet check on `connect` — it is the only one that costs money to start — and leave the reads cheap. The route exposes no avatar mutation at all: creating or deleting a character is a server-side job for the `RealtimeAvatar` class, never something a browser reaches through this handler — so there is nothing to forget to gate. Every operation still passes `authorize`, so this callback is the gate, not a second line behind one.

A key with a `NEXT_PUBLIC_` or `VITE_` prefix is inlined into the client bundle at build time. That is the one mistake that actually leaks a key, and the prefix is the only warning you get.

### What the client is not allowed to decide

The persona, the memory, the voice, and the time limit are all yours. The handler strips them from whatever the browser sent and uses your `session` policy instead — and a field your policy does not set is **absent** rather than inherited, so forgetting one fails closed.

The one worth getting right on day one is `maxSeconds`: it is what stops a call your balance cannot cover. See [Calls](https://realtimeavatar.ai/docs/sessions) for the full policy.
