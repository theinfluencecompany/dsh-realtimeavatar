---
name: realtimeavatar-api
description: Realtime Avatar REST API reference: each endpoint with scope, request casing, error codes (401/402/403/409/422/429), rate limit, idempotency, and the rta_* tool that wraps each. Load before calling the API directly.
snapshot: 2026-09-03
sources: docs/api-reference.md
---

> Snapshot of the public documentation at https://realtimeavatar.ai taken on 2026-09-03. For the current text of any page call the `rta_docs` tool; the canonical pages are linked under every section.

## Endpoints and the rta_* tools (verified against https://realtimeavatar.ai/openapi.json on 2026-09-03)

Base URL `https://realtimeavatar.ai/api/v1`, `Authorization: Bearer tic_…`. Realtime routes take snake_case bodies; resource routes take camelCase. Per-key throttle: 120 requests per 60 seconds.

| Method | Path | Scope | Spends credits | dsh tool |
|---|---|---|---|---|
| GET | `/realtime/livekit/capacity` | `realtime:write` | no | rta_capacity |
| POST | `/realtime/livekit/session` | `realtime:write` | yes | rta_session_mint |
| POST | `/realtime/livekit/session/release` | `realtime:write` | no | rta_session_release |
| GET | `/avatars` | `avatars:read` | no | rta_avatars |
| POST | `/avatars` | `avatars:write` | yes | rta_avatar_create |
| GET | `/avatars/{avatarId}` | `avatars:read` | no | rta_avatar |
| PATCH | `/avatars/{avatarId}` | `avatars:write` | no | rta_avatar_update |
| DELETE | `/avatars/{avatarId}` | `avatars:write` | no | rta_avatar_delete |
| GET | `/avatars/{avatarId}/clips` | `avatars:read` | no | rta_clips |
| PUT | `/avatars/{avatarId}/clips` | `avatars:write` | yes | rta_clips_set |
| POST | `/avatars/{avatarId}/clips` | `avatars:write` | no | — (deprecated) |
| PUT | `/avatars/{avatarId}/loop` | `avatars:write` | yes | rta_loop_set |
| POST | `/api-keys` | `api_keys:write` | no | — (not exposed) |
| GET | `/assets` | `avatars:read` | no | rta_assets |
| POST | `/assets` | `avatars:write` | no | — (not exposed) |
| POST | `/assets/remote` | `avatars:write` | no | rta_asset_remote |
| GET | `/credits/balance` | `credits:read` | no | rta_balance |
| GET | `/usage/sessions` | `usage:read` | no | rta_usage |

| Status | Meaning | What to do |
|---|---|---|
| 401 | Missing, malformed, revoked, or expired key | Check the bearer and the environment tag |
| 402 | insufficient_credits or spend_limit_exceeded | Top up (billingUrl) or raise the per-key spend limit; surface as a paywall |
| 403 | The key lacks the scope for this operation, or the workspace is not active (error reads "Tenant is not active"), or a per-workspace rollout gate (code clip_library_not_enabled) | Read error first: mint a key with the scope (do not widen to *); an inactive workspace has to be reactivated (no self-serve switch); a rollout gate needs support |
| 404 | No such avatar, voice, or key for this tenant | Check the id; soft-deleted avatars are gone from every read |
| 409 | Conflict: no workspace yet, idempotency conflict, or avatar state settling | Read the error text; retry after it settles, or use a fresh Idempotency-Key |
| 413 | JSON body over the per-route cap | Send media by URL, not inline |
| 422 | Schema rejection (unknown, mis-cased or invalid field) or a safety-screen refusal | Check camelCase vs snake_case for the route |
| 429 | Plan concurrency ceiling (code concurrency_limit_reached), capacity queue (queue_size + recommended_retry_ms), or the per-key rate limit (no code, no queue fields) | Close a session / upgrade; render the queue position and retry; or back off |
| 502 | An upstream generation or render failed | Retry; if it persists it is theirs, not yours |
| 503 | A dependency the route needs is unavailable; nothing was written | Retry with backoff |

### Operation table from the live OpenAPI document

Base URL: https://realtimeavatar.ai/api/v1 — bearer auth (`Authorization: Bearer tic_…`).

| Method | Path | operationId | Summary | Scope | Credits | rta tool |
|---|---|---|---|---|---|---|
| GET | `/v1/realtime/livekit/capacity` | getLiveKitCapacity | Get a capacity snapshot | realtime:write | no | rta_capacity |
| POST | `/v1/realtime/livekit/session` | createLiveKitSession | Mint a realtime session | realtime:write | yes | rta_session_mint |
| POST | `/v1/realtime/livekit/session/release` | releaseLiveKitClientSession | Release a session's capacity lease | realtime:write | no | rta_session_release |
| GET | `/v1/avatars` | listAvatars | List avatars | avatars:read | no | rta_avatars |
| POST | `/v1/avatars` | createAvatar | Create an avatar from a portrait | avatars:write | yes | rta_avatar_create |
| GET | `/v1/avatars/{avatarId}` | getAvatar | Get an avatar | avatars:read | no | rta_avatar |
| PATCH | `/v1/avatars/{avatarId}` | updateAvatar | Update an avatar | avatars:write | no | rta_avatar_update |
| DELETE | `/v1/avatars/{avatarId}` | deleteAvatar | Delete an avatar | avatars:write | no | rta_avatar_delete |
| GET | `/v1/avatars/{avatarId}/clips` | listAvatarClips | List an avatar's motion clips | avatars:read | no | rta_clips |
| PUT | `/v1/avatars/{avatarId}/clips` | putAvatarClips | Declare an avatar's clip library | avatars:write | yes | rta_clips_set |
| POST | `/v1/avatars/{avatarId}/clips` | syncAvatarClips | Sync an externally hosted clip library | avatars:write | no | — |
| PUT | `/v1/avatars/{avatarId}/loop` | putAvatarLoop | Re-direct an avatar's resting loop | avatars:write | yes | rta_loop_set |
| POST | `/v1/api-keys` | createApiKey | Mint an API key | api_keys:write | no | — |
| GET | `/v1/assets` | listAssets | List assets | avatars:read | no | rta_assets |
| POST | `/v1/assets` | uploadAsset | Upload an asset | avatars:write | no | — |
| POST | `/v1/assets/remote` | createRemoteAsset | Create an asset from a URL | avatars:write | no | rta_asset_remote |
| GET | `/v1/credits/balance` | getCreditBalance | Get the credit balance | credits:read | no | rta_balance |
| GET | `/v1/usage/sessions` | listUsageSessions | List billed realtime sessions | usage:read | no | rta_usage |

## API reference

Source: https://realtimeavatar.ai/docs/api-reference (markdown: https://realtimeavatar.ai/docs/api-reference.md, updated 2026-09-02)

> Every public endpoint on https://realtimeavatar.ai/api/v1 — what it takes, what it returns, which scope it needs, and how it fails.

- Canonical: https://realtimeavatar.ai/docs/api-reference
- Updated: 2026-09-02

Base URL `https://realtimeavatar.ai/api/v1`. Every request carries `Authorization: Bearer tic_…`. A machine-readable spec for the realtime surface lives at [/openapi.json](https://realtimeavatar.ai/openapi.json).

**curl**

```bash
curl https://realtimeavatar.ai/api/v1/credits/balance \
  -H "Authorization: Bearer $REALTIME_AVATAR_API_KEY"
```

**TypeScript**

```ts
import { RealtimeAvatar } from "realtime-avatar";

const rta = new RealtimeAvatar({ apiKey: process.env.REALTIME_AVATAR_API_KEY! });
await rta.creditBalance();
```

**Python**

```python
import os, httpx

client = httpx.Client(
    base_url="https://realtimeavatar.ai/api/v1",
    headers={"Authorization": f"Bearer {os.environ['REALTIME_AVATAR_API_KEY']}"})

client.get("/credits/balance").json()
```

### Realtime

| Endpoint | Scope | Notes |
| --- | --- | --- |
| `POST /realtime/livekit/session` | `realtime:write` | Mint a session. Returns a grant, or **429** with the queue contract when capacity is full. See [Calls](https://realtimeavatar.ai/docs/sessions). |
| `POST /realtime/livekit/session/release` | `realtime:write` | Free the call's slot. Free of charge and idempotent, so calling it twice — or on a call that already ended — is safe. `{ session_id \| queue_ticket_id, reason?, capacity_pool? }` — one of the two ids is required. `reason` is a closed set: `page_hide · disconnected · superseded · unmount · manual · idle_timeout`. Anything else is a **422**, and a rejected release frees nothing — the slot stays held until it expires on its own, so send one of these or omit the field. The SDK sends it for you. |
| `GET /realtime/livekit/capacity` | `realtime:write` | Snapshot of **one** pool — the orchestrator default, named by `capacity_pool` in the body (`primary`). Mints fail over across pools and voice calls are not capacity-gated, so this does not predict whether a mint will be granted. Do not gate a call on it: mint, and treat the **429** as the queue. |

### Avatars

| Endpoint | Scope | Notes |
| --- | --- | --- |
| `GET /avatars` | `avatars:read` | List the workspace's avatars (most recently updated first, capped at 100) as `{ data: [...] }`. |
| `POST /avatars` | `avatars:write` | `{ displayName, sourceAssetId?, motionPrompt?, voice?, defaultVoiceId?, llm?, settings?, metadata? }` → 201 (`preprocessing` with a portrait attached; `draft` without one). Creation is **image-only**: `sourceAssetId` names an uploaded portrait and the platform generates the looping idle video plus a multi-clip motion library in the background — poll until `status` is `ready`. `motionPrompt` optionally art-directs the generated loop. Custom video upload is not supported. |
| `GET /avatars/{id}` | `avatars:read` | Includes `status`: `draft · preprocessing · ready · failed · disabled · deleted` and `idleVideoStatus`: `none · queued · generating · ready · failed` (the background motion-generation progress). Mint only against `ready`; on `failed`, `error` says why. |
| `PATCH /avatars/{id}` | `avatars:write` | Partial update; at least one field required. `portraitUrl` is in the schema but is **dashboard-only** — over this API it is always **400**. To change the portrait, register the image with `POST /assets` or `POST /assets/remote` and PATCH the returned id as `sourceAssetId`, which is its own swap lane: it consumes `anchorTimeMs` as the new source's frame and is exclusive of every other field. |
| `DELETE /avatars/{id}` | `avatars:write` | Soft delete. |
| `GET /avatars/{id}/clips` | `avatars:read` | The avatar's declared motion library as `{ data: [{ clipId, role, status, url, whenHint, source, uploadAssetId }] }`. `status` is the current job state, while `url` is the serving take and may stay non-null during a re-render or after its failure. `uploadAssetId` is non-null only for uploaded clips, so GET can be losslessly declared back with PUT. Render sessions inherit serving clips unless the mint supplies its own `clip_library` (an explicit empty array opts out). |
| `PUT /avatars/{id}/loop` | `avatars:write` | Re-direct the **resting loop** — the video she plays when nothing else is happening — from a new `motionPrompt`. This is not a clip: a clip with `role: "idle"` is a variant spliced over the loop, and declaring one never changes what she rests in. Answers `202`; the render takes minutes, during which she stays `ready` and keeps serving her previous loop (returned as `servingUrl`), then the swap publishes at once. Your clip library is untouched. Billed as one generation. Requires a portrait to re-animate — `422 loop_not_generatable` (terminal) when she has none: a draft created without `sourceAssetId`, or a grandfathered avatar built from a supplied video. Do not gate on `sourceKind`: it reads `video` for every avatar once her generated loop attaches. `409 loop_pending` means one is already in flight. The description is screened like a clip's (`422 loop_prompt_rejected`). |
| `PUT /avatars/{id}/clips` | `avatars:write` | Declare the library you want, in full — the platform reconciles: renders what is new, keeps what matches, retires what you dropped. Each clip carries a `clipId`, a `role`, an optional `whenHint`, and a `source` that is either a `motionPrompt` (the platform renders it from the avatar's anchor frame) or an `assetId` you uploaded. Send `expectedRevision` to make the write a compare-and-swap — a stale one is `409 revision_conflict`, which carries the current `revision` to re-read. Answers `202` with the plan. Rolling out per tenant (`403 clip_library_not_enabled` until yours is on). Descriptions are screened before they render: a refused one is `422 clip_declaration_rejected` with the reason, and if the screen itself cannot run the write is refused rather than waved through — `503 clip_screen_unavailable`, retryable. |
| `POST /avatars/{id}/clips` | `avatars:write` | **Deprecated — do not build on this.** Clips are generated by the platform from the avatar's portrait at creation time; list them with the GET above. This route only reconciles an **externally hosted** clip library to the video cache by URL hash, for tenants that served their own clips before generated libraries existed. Listed because it is still callable and still in the spec — not because you should reach for it. |

### Assets

| Endpoint | Scope | Notes |
| --- | --- | --- |
| `GET /assets` | `avatars:read` | List uploaded assets. |
| `POST /assets` | `avatars:write` | Multipart: `file`, optional `kind` (`image \| video \| audio`) → 201. Video assets are accepted as uploaded motion-clip sources; they do not reopen custom-video Avatar creation. A clip declaration pose-validates video and requires it to fit the 18 MB QC ceiling. |
| `POST /assets/remote` | `avatars:write` | `{ kind, remoteUrl, originalFilename?, metadata? }` — the platform streams the file into storage. Video assets may be referenced by `PUT /avatars/{id}/clips`; prefer remote registration when the bytes already live in object storage. |

### Billing and keys

| Endpoint | Scope | Notes |
| --- | --- | --- |
| `GET /credits/balance` | `credits:read` | Balance and currently reserved credits, in micros. Live sessions hold a reservation for their duration. |
| `GET /usage/sessions` | `usage:read` | Per-session billing detail — when each session ran, how long it was billable for, and what it cost. This is what reconciles an invoice, or re-bills your own users; the dashboard aggregate can do neither. The window defaults to the trailing 30 days and is **clamped** to 90 — a wider range is served narrowed, not refused, so read back the returned `from`/`to`. Page with `nextCursor`. `?endUserId=` narrows to one of your users when the call was tagged with `client_metadata.user_id`. **Read `status` before you sum anything.** Only `released` and `failed` are settled: `released` is the normal end of a call and carries the charge, `failed` is terminal and always `billedCreditMicros: 0`. The other two are not final — `reserved` is a slot that was held and never became a call, and `started` is still in flight. Both report `billedCreditMicros: 0` *provisionally*: a `started` row settles when the session is released, so the same session read again tomorrow can carry a different number. Reconcile on the settled rows and treat the rest as pending, not as free. |
| `POST /api-keys` | `api_keys:write` | `{ name, environment?, scopes?, spendLimitCreditMicros?, expiresAt? }`. Only `name` is required, and the two defaults decide what you get: `environment` defaults to `test`, so a key created without it carries the `tic_test_` prefix; `scopes` defaults to `realtime:write`, `credits:read` and `avatars:read`, which starts calls and reads but writes no avatars. The plaintext key is returned once. |

### Errors

| Status | Meaning | What to do |
| --- | --- | --- |
| 401 | Missing, malformed, revoked, or expired key | Check the bearer and the environment tag |
| 403 | The key lacks the scope for this operation, or its workspace is not active (`error` reads `Tenant is not active`) | Read `error`: mint a key with the scope (do not widen to `*`), or have the workspace reactivated — there is no self-serve switch for that |
| 402 | `insufficient_credits` or `spend_limit_exceeded` | Top up, or raise the per-key spend limit. Surface this as a paywall, not as a connection failure. |
| 409 | A conflict with state that already exists. Three kinds reach this API: no workspace on the account yet; an **idempotency** conflict (a key still in flight, or reused with a different body); and an **avatar state** conflict — it is disabled, already has a motion video, has no portrait to animate, or a change is still settling. | Read `error` — the three kinds want different things. A workspace is a one-time setup in the dashboard; an idempotency conflict wants a fresh `Idempotency-Key` (never the same one); an in-flight change wants a plain retry once it settles. |
| 404 | No such avatar, voice, or key — *for this tenant*. The message often reads "does not belong to this tenant", which sounds like a permission problem and is usually a wrong or already-deleted id. | Do not route this to your access-denied branch — 403 is the permission answer. Check the id, and remember a soft-deleted avatar is gone from every read. |
| 413 | The JSON body is over this route's cap | See the cap sizes under Conventions. This is almost always inlined media — send it as an asset and reference the id. |
| 422 | Schema rejection — an unknown, mis-cased, or invalid field | The wire schemas are strict. Check camelCase vs snake_case at the layer you are writing. |
| 429 | Plan concurrency ceiling, capacity full (session mint), or rate limited | A mint has **two** 429s, and they want opposite reactions. With `code: "concurrency_limit_reached"` the plan’s concurrent-stream ceiling is reached and **no queue will drain it** — close a session or upgrade. Sandbox allows one stream, so a second tab produces it. Without a `code`, look at the body before deciding. A **queue** answer carries `queue_size` and `recommended_retry_ms`: the SDK returns a queued result (`isQueued`) with `position` and `retryAfterMs` — render the position and retry. Deliberately not auto-retried: a blind retry would burn the backoff to receive the same answer. A body with *neither a code nor those fields* is the **per-key rate limit** (see Conventions) — back off, do not treat it as a queue position. Check the body before trusting `isQueued`: the SDK maps every 429 to a queued result, so both a concurrency refusal and a throttle reach you as `position: null` on a queue that does not exist. |
| 502 | An upstream generation or render failed | Retry; if it persists it is ours, not yours |
| 503 | A dependency this route needs is unavailable — a render queue that would not accept the job, a staging pipeline that is down, or (`clip_screen_unavailable`) the screen that vets clip descriptions. Never your request's fault. | Retry with backoff. Nothing was written, so a retry is safe and needs no `Idempotency-Key` to be correct — though sending one costs nothing. |

### Conventions

- All `/api/v1` responses are `Cache-Control: no-store`.
- Request bodies are size-capped per route — 4 KB on the session release, 64 KB on the clip-library `PUT`, 8–32 KB everywhere else. Over the cap is a **413**. Send media by URL, not inline.
- **`Idempotency-Key` is honoured on the two writes that cost money to repeat** — `PUT /avatars/{id}/clips` and `PUT /avatars/{id}/loop`. Replay returns the original response rather than doing the work twice. It matters most on the loop, where a repeated re-direct is a *second billed render*; the clip library reconciles, so an identical repeat keeps what already matches and re-renders nothing either way. Reuse the same key with a *different* body and you get a **409** — a retry means the same request, so generate a fresh key for a changed one. No other endpoint reads the header.
- **120 requests per 60 seconds, per key.** The throttle is applied when the key is verified, so it covers every `/api/v1` endpoint, and it counts per *key* rather than per workspace — splitting a workload across keys raises the ceiling. Over it is a **429** whose body carries no `code` and no queue fields, which is how you tell it from the other two. Worth sizing against: the creation flow asks you to poll `GET /avatars/{id}` until `status` is `ready`, and a render takes minutes — poll on the order of seconds, not milliseconds.
- Ids are prefixed and stable: `ava_` avatars, `tic_` API keys.
- The SDK covers the integration path — calls, avatars, assets, usage, credits — with a surface that is deliberately *narrower* than this wire, though less narrow than it once was. Avatar update and delete *are* in it (`updateAvatar`, `deleteAvatar`), as are `getAvatar`, `listAvatars`, `listClips`, `setClipLibrary`, `syncClips`, `retimeAnchor`, `swapSource` and `iterateSessions`. Prefer it over hand-rolled fetches wherever it reaches. What it leaves out is **key minting**, the **capacity** snapshot and the **asset listing** — those three are a plain authenticated fetch against the endpoints above.
