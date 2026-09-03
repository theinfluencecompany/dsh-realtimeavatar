---
name: realtimeavatar-calls
description: Realtime Avatar calls: the server-authoritative session policy (instructions, context, maxSeconds, voice, video, clientTools, transcript), the five client states, ending a call gracefully, tool calling (client tool plane and server loop), and experimental features. Load when designing call behaviour or tools.
snapshot: 2026-09-03
sources: docs/sessions.md, docs/tool-calling.md, docs/experimental.md
---

> Snapshot of the public documentation at https://realtimeavatar.ai taken on 2026-09-03. For the current text of any page call the `rta_docs` tool; the canonical pages are linked under every section.

## Calls

Source: https://realtimeavatar.ai/docs/sessions (markdown: https://realtimeavatar.ai/docs/sessions.md, updated 2026-09-02)

> What your server decides, what the client reports, and how to end a call without cutting the character off mid-sentence.

- Canonical: https://realtimeavatar.ai/docs/sessions
- Updated: 2026-09-02

A call is one live conversation. Your server decides who may start one and what the character knows; the client renders it and reports five states. Those are the only two surfaces you touch.

### What your server decides

The `session` policy on your connect endpoint. Every field here is authoritative — whatever the browser sent for these is discarded, and a field you do not set is absent rather than inherited from the caller. The Field column is the SDK name; the Wire column is the key a hand-rolled request sends — snake_case and strict, see Calling the API directly below.

| Field | Wire | What it does |
| --- | --- | --- |
| `instructions` | `instructions` | Her behavior contract — who she is and how she speaks. Up to 4,000 characters. The highest-leverage field on the whole surface. |
| `context` | `initial_context` | Up to 32 prior messages, replayed as memory. This is what makes a call continue a story instead of starting cold. On the wire it is `initial_context`, and each entry is `{ role: "system" \| "user" \| "assistant", content }` with content 1–4000 characters — the SDK types this for you, raw HTTP does not. |
| `maxSeconds` | `max_session_seconds` | Hard stop, up to 1800. Enforced on our side, so it holds even if your client stops reporting. Compute it from the balance you just admitted. |
| `listen` | `stt_mode: "server" \| "off"` | Speech recognition. Default true — she hears the user the whole call. Set `false` only if you drive every turn yourself — see [Tool calling](https://realtimeavatar.ai/docs/tool-calling). |
| `voice` | `voice` | Override her stored voice for this call. |
| `video` | `render_backend: "generative"`, or omit it | How she is rendered: omit it for the generated loop + state map, or `{ mode: "generative" }` to synthesize the video live — see [Creating an avatar](https://realtimeavatar.ai/docs/video). |
| `clientTools` | `capabilities: ["client_tools"]` | `true` opts the call into the client tool plane — functions declared in your page that she can call mid-conversation. See [Tool calling](https://realtimeavatar.ai/docs/tool-calling). |
| `transcript` | `transcript_webhook: { url, secret }` — https URL, secret 16–200 chars | `{ url, secret }` — get the two-sided transcript back, signed, after the call ends. On the wire it is `transcript_webhook`, and `secret` is 16–200 characters — the SDK types this for you, raw HTTP does not. See [Tool calling](https://realtimeavatar.ai/docs/tool-calling). |
| `metadata` | `client_metadata` | Up to 16 string pairs, echoed verbatim on that transcript so you can attribute it without a lookup. |

### Two modes

| Mode | What the user gets | Use it for |
| --- | --- | --- |
| `avatar` (default) | She is on screen — audio and video | The full call |
| `voice` | Audio only | A cheaper on-ramp, or a fallback when bandwidth will not carry video |

Same character, same policy — only `mode` changes. A voice call draws on separate capacity, so it never competes with a video call.

### What the client reports

Five states. Write copy for the ones you care about; the SDK ships none.

| `status` | Meaning |
| --- | --- |
| `connecting` | Getting her ready |
| `waiting` | Every slot is busy and you are holding a place in line — `call.queuePosition` has the number. **Not an error**; the SDK retries for you. Render the position, not a failure. |
| `live` | She is there |
| `recovering` | A blip; reconnecting automatically with backoff |
| `ended` | Over — `onEnded` already told you why |

### What you can do mid-call

**TypeScript**

```ts
call.say(text, { steer })  // say something to her; `steer` shapes THIS reply only
call.sayAndEnd(text)       // speak one exact line, verbatim, then close
call.keepAlive()           // the user is still here — postpone the idle disconnect
call.end()                 // end now
call.secondsRemaining      // to the hard stop, or null before the clock lands
call.queuePosition         // place in line while waiting, else null
```

**Python**

```python
# These are CLIENT-side actions — they act on a live call, which lives in the
# browser or native app. A Python backend owns the policy, not the live turn.
#
# What Python does own — and there is no Python SDK, so this half is plain HTTP:
#   POST /realtime/livekit/session           mint a call — body is snake_case and strict:
#                                            avatar_id, mode, instructions, initial_context,
#                                            max_session_seconds, stt_mode, capabilities,
#                                            transcript_webhook, client_metadata (the Wire
#                                            column above, not the SDK field names)
#   POST /realtime/livekit/session/release   free the slot early
#   GET  /credits/balance                    what the next call must fit inside
```

See [Tool calling](https://realtimeavatar.ai/docs/tool-calling) for the Python side of the conversation — the signed transcript you receive when a call ends.

`say(text, { steer })` is the hook for tool results — `steer` applies to one reply and then evaporates, so a lookup result cannot leak into every later turn. See [Tool calling](https://realtimeavatar.ai/docs/tool-calling).

### Ending well

A call that stops mid-sentence feels broken no matter how good the render was. When time is nearly up you get a callback and a handle; whatever you pass to `sayAndEnd` is spoken **exactly as written** — never rewritten by the model, never interrupted — and only then does the call close.

```tsx
<AvatarCall
  client={client}                                  // createProxyClient({ proxyUrl })
  avatarId={avatarId}
  balanceMs={creditRemainingMs}

  onEnding={async ({ secondsLeft, call }) => {
    if (secondsLeft > 15) return;                 // wait for the last window
    call.sayAndEnd(await writeGoodbye(character));
  }}
  onQuiet={({ secondsLeft }) => toast(`Still there? (${secondsLeft}s)`)}
  onLowBalance={({ secondsLeft }) => openTopUp(secondsLeft)}
  onEnded={({ reason }) => showEndScreen(reason)}
/>
```

`onEnded` always carries one of `user_ended` · `session_cap` · `idle` · `disconnected` · `out_of_credits` · `agent_ended` · `failed`. Key your end screen off it — "talk again?" and "you're out of minutes" are different screens with different outcomes.

The idle timer is real and enforced: when it fires the client disconnects and capacity is freed. That is deliberate. An abandoned tab holding a live character is the most expensive thing that can happen in this product, and it would be on your bill.

**You can also release a call from your server.** `rta.endCall(sessionId, { reason })` frees the slot immediately — best-effort and idempotent: `true` when acknowledged, `false` for anything else, never a throw, so calling it twice (or on a call that already ended) is safe. Reach for it when your backend learns the call is over before the client does: a webhook, an admin action, a superseded reconnect. (Wire: `POST /realtime/livekit/session/release`, `realtime:write` scope.)

From the client, `call.end()` is the same thing and is what you normally want. The SDK also sends a release on tab-close via `releaseLiveKitSessionBeacon()`, which survives the page going away where a normal `fetch` would not. Release early and often: a held slot is capacity nobody else can use, and the queue is shared.

### Calling the API directly

Not on TypeScript? The same call is one authenticated POST — the Python tab on [Quickstart](https://realtimeavatar.ai/docs/quickstart) has a working endpoint. Two things to know before hand-rolling it:

- **Every endpoint is strict, and casing is per endpoint.** An unknown or mis-cased key is a rejected call, not a dropped field — and which casing is right depends on where you are writing. The realtime routes on this page (`/realtime/livekit/session` and its `/release`) are **snake_case**; every REST resource endpoint — avatars, clips, keys, assets — is **camelCase**. Measured against the published spec: 2 of the 9 request bodies are snake_case at the top level and 7 are camelCase — with one exception worth knowing, because the strictness above turns it into a 422: `POST /avatars` is camelCase outside and **snake_case inside** `voice` (`auto_description`, `voice_id`). The SDK translates its camelCase policy for you; a hand-rolled request has no such help — send the Wire column from the policy table above (`initial_context`, `max_session_seconds`, `transcript_webhook`, `client_metadata`…), never the SDK names.
- **Pass the connection payload to your client byte-for-byte.** It is validated strictly — add one key and the client rejects the whole thing, so the call never opens and nothing points at the cause.

Full endpoint list, scopes, and error codes: [API reference](https://realtimeavatar.ai/docs/api-reference).

## Tool calling

Source: https://realtimeavatar.ai/docs/tool-calling (markdown: https://realtimeavatar.ai/docs/tool-calling.md, updated 2026-09-02)

> The platform never executes your tools. Here is the boundary, the client tool plane, and the server loop that turns a call into a working agent with a face.

- Canonical: https://realtimeavatar.ai/docs/tool-calling
- Updated: 2026-09-02

**Your tools never run on the platform.** There is no hosted executor — a tool executes in your page or on your server, with your credentials, under your authorization rules. That is a deliberate boundary, not a gap we forgot to fill.

The reason is trust. A hosted tool runner would need your credentials, your authorization rules, and a say in when a side effect fires. Your backend already has all three and already knows which user is on the call. So execution stays where the trust already is, and you get two lanes to wire it in: **client tools**, where she calls a function you declared in your page mid-conversation, and **server steering**, where your backend runs the agent loop and hands her the result to say.

### Client tools: functions she can call in your page

Opt in at mint with `clientTools: true` (wire `capabilities: ["client_tools"]`) — part of the call policy, so it is your server's decision like everything else — then declare the tools in the page after the room connects. The manifest is registered over RPC; nothing about a tool ever appears in the mint request, and the tool name is the record key.

**TypeScript**

```ts
// Server — the connect route opts the call in. Policy, like everything else.
session: async () => ({ instructions, clientTools: true }),

// Page — after room.connect(). The name she calls is the record key.
import { attachAvatarTools, type AvatarTool } from "realtime-avatar/tools";

const check_order: AvatarTool<{ order_id: string }> = {
  description: "Look up the status of an order by id",
  parameters: {
    type: "object",
    properties: { order_id: { type: "string" } },
    required: ["order_id"],
  },
  execute: async ({ order_id }) =>
    await fetch("/api/orders/" + order_id).then((r) => r.json()),
};

const { accepted, rejected } = await attachAvatarTools(room, { check_order });
```

**A tool has 2.5 seconds.** That is a conversational floor, not a tunable — past a couple of seconds of dead air the call stops feeling live. The platform abandons the call after the deadline and tells her it failed, and the abort is *cooperative*: every `execute` receives an `AbortSignal`, but a handler that ignores it still runs to completion and can commit a side effect — only its *result* is discarded. Make anything slow idempotent, or check `signal.aborted` before you write. A tool that calls a model does not fit: return an acknowledgement inside the deadline and deliver the real answer on screen when it lands. And read the `{ accepted, rejected }` return — a rejected schema is a tool she simply does not have.

### Server steering: the two primitives

| Call | What happens | Use for |
| --- | --- | --- |
| `sendTurn(text, { instructions })` | Interrupts stale speech and generates a reply to `text`, with `instructions` applied to *this turn only* — passed as generation instructions, not concatenated into the user message. | Injecting a tool result and letting the character deliver it in her own voice |
| `sendClosingTurn(text)` | Speaks `text` **verbatim** — never routed through the model — uninterruptibly, then ends the session. | The one line that must be exact: a goodbye, a legal disclosure |

Per-turn `instructions` is the tool-result channel. It steers wording, register, and content for one reply and then evaporates — it does not mutate the session prompt, so a tool result cannot leak into every later turn.

### The loop

Run your agent where your data is: on your server. The call is the interface, not the brain.

**TypeScript**

```ts
// 1. You observe the user's turn. 2. Your agent decides a tool is needed
// and runs it. 3. You hand the RESULT back and let her say it.
const result = await tools.checkOrderStatus({ userId, orderId });

await session.sendTurn(userText, {
  instructions: [
    "Answer using ONLY these facts:",
    JSON.stringify(result),
    "One or two spoken sentences. Do not read the JSON aloud.",
  ].join("\n"),
});
```

**Python**

```python
import json
from fastapi import Depends

# The live turn is client-side, so Python's role is to DECIDE and to receive.
# Your client calls your endpoint; you run the tool and return the steer text.
@app.post("/api/turn")
def turn(req: TurnRequest, user=Depends(current_user)):
    result = check_order_status(user.id, req.order_id)
    return {
        "text": req.text,
        "steer": (
            "Answer using ONLY these facts: "
            f"{json.dumps(result)}. "
            "One or two spoken sentences. Do not read the JSON aloud."
        ),
    }
```

The client passes that straight into `sendTurn(text, { instructions: steer })`. Keeping the decision on your server is the point — the credentials and the authorization rules already live there.

For a deterministic string — a confirmation number, a price, a required disclosure — do not route it through the model at all. Use the verbatim path so what she says is exactly what you wrote.

#### Latency

A tool call between the user finishing a sentence and the character starting to speak is dead air, and dead air on a video call is louder than on a chat. Two things help:

- **Speak first, then resolve.** Send a short acknowledging turn immediately ("let me look"), run the tool, then send the answer turn.
- **Pre-fetch at mint.** Anything you can know before the call starts belongs in the policy's `context` (wire `initial_context`), not in a tool call three seconds in.

### Getting the conversation back

Your agent needs to know what was said — and what she did. Register a transcript webhook at mint time (wire `transcript_webhook`: an https URL and a 16–200 character secret; tag the session with `client_metadata`) and you get a signed POST after the call ends with the full two-sided transcript (`segments`) and the tool calls the model acted on (`tool_calls`: name, arguments, result or error, and duration). It is sent after capacity is released, so it never delays the next caller. Delivery is at-least-once: the worker waits 5 seconds for your answer, retries once after ~2 seconds on a 5xx or a timeout with the identical body and signature, and takes any status under 500 as delivered. A session with no committed turns and no tool calls sends nothing:

**TypeScript**

```ts
// Registered on your connect endpoint — server-side only.
session: async ({ avatarId }) => ({
  instructions,
  transcript: { url: "https://your.app/api/rta/transcript", secret: TRANSCRIPT_SECRET },
  // Echoed verbatim, so the keys are yours — except user_id, which
  // GET /usage/sessions?endUserId= filters on.
  metadata: { user_id: user.id, characterId: avatarId, mode: "video" },
})
```

**Python**

```python
import hashlib, hmac, json, time
from fastapi import BackgroundTasks, HTTPException, Request

# Mint half — in your connect route, next to avatar_id. Wire names, not the
# SDK's transcript / metadata.
body["transcript_webhook"] = {"url": "https://your.app/api/rta/transcript",  # https only
                              "secret": TRANSCRIPT_SECRET}                   # 16..200 chars
body["client_metadata"] = {"user_id": str(user.id), "characterId": character.avatar_id,
                           "mode": req.mode}                                 # up to 16 string pairs

# Receiver half.
MAX_SKEW_SECONDS = 300

def verify(body: bytes, signature: str, timestamp: str, secret: str) -> bool:
    if not timestamp.isdecimal() or abs(time.time() - int(timestamp)) > MAX_SKEW_SECONDS:
        return False                                  # missing, malformed, or stale: replay-bound
    signed = f"{timestamp}.{body.decode()}".encode()
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"v1={expected}", signature)

@app.post("/api/rta/transcript")
async def transcript(request: Request, tasks: BackgroundTasks):
    raw = await request.body()                        # RAW bytes, before any parsing
    if not verify(raw, request.headers.get("x-rta-signature", ""),
                  request.headers.get("x-rta-timestamp", ""), TRANSCRIPT_SECRET):
        raise HTTPException(401)
    payload = json.loads(raw)
    if already_saved(payload["session_id"]):          # at-least-once: dedupe on session_id
        return {"ok": True}
    user_id = (payload.get("client_metadata") or {}).get("user_id")   # None when the mint set none
    tasks.add_task(save_turns, user_id, payload["segments"])
    tasks.add_task(save_tool_calls, user_id, payload.get("tool_calls", []))   # absent when none ran
    return {"ok": True}                               # answer inside 5 s; save after
```

Sign over the **raw request bytes**. Parsing to a dict and re-serializing changes the whitespace, and the signature will never match. `TRANSCRIPT_SECRET` is the same secret you passed as `transcript_webhook.secret` at mint. The URL must be https — the mint accepts http, but the worker silently drops it and nothing is ever delivered.

**Registering it without the SDK.** The TypeScript tab above turns the webhook on; the Python tab only verifies what arrives. If your server mints over raw HTTP, the field on the mint body is `transcript_webhook` — not `transcript`, which is the SDK's name for it — and the mint is strict, so the wrong key is a 422 rather than a dropped field and no webhook is ever sent. `secret` must be 16–200 characters: it is the HMAC key the handler below verifies against, so generate it rather than typing one.

The POST carries `x-rta-signature: v1=<hex hmac>` and `x-rta-timestamp`; the signed payload is `"<timestamp>.<body>"` under HMAC-SHA256 with your shared secret. Verify it before trusting anything, and reject stale timestamps. `client_metadata` comes back verbatim (`{}` when the mint sent none), so you can attribute the transcript without a session lookup, and `session_id` is the key to dedupe a retry on.

`tool_calls` is present only when the session ran at least one tool. Each entry is `{name, call_id, arguments, ts, ok, result | error, duration_ms}`; an entry with no `ok` field means the call produced nothing the model saw. Store it next to the segments — a reply grounded in a lookup is only auditable if the lookup itself is in the history. Arguments and results are truncated to 2,000 characters each and at most 200 calls are recorded (`tool_calls_truncated: true` marks an overflow); this is a history, not a replay. One known gap: a tool round belonging to a turn the user barged in over is not reported by the runtime, so its calls are absent even though they ran.

The platform stores no conversation text. If you do not register a webhook, nothing is buffered and nothing is sent — which is the right default for most apps, and the only acceptable one for some.

### Bringing your own model

If your agent loop is complex enough that per-turn steering feels like fighting it, you can go further: mint with `listen: false` (wire `stt_mode: "off"`), keep speech recognition on your side, and drive every turn through `sendTurn` with tight instructions. At that point the platform is a rendering endpoint for a character you fully control, and every tool decision is yours. That is a supported way to use it.

You can also select the brain per session with `llm` (provider + model) when you want the hosted loop but a different model behind it.

## Experimental features

Source: https://realtimeavatar.ai/docs/experimental (markdown: https://realtimeavatar.ai/docs/experimental.md, updated 2026-08-26)

> What is experimental right now, what that word promises, and how to turn each one on. Included with Studio and above.

- Canonical: https://realtimeavatar.ai/docs/experimental
- Updated: 2026-08-26

Some capabilities ship before their shape is settled. Rather than hide them behind a flag you have to ask us for, they are on your account from **Studio** up, opt-in per call, and listed here so you can see exactly what you are taking on.

### What "experimental" promises

It is a statement about the request shape, not a warning about quality:

- **The shape may change in a minor release**, without the deprecation window a stable field gets. Pin an exact SDK version if that matters to you.
- **It may be inert while it rolls out.** A call that asks for an experimental capability always connects and always behaves like a normal call; the extra behaviour may simply not happen yet. Nothing errors and nothing is billed differently.
- **It is off unless you ask.** Omit the field and your call is byte-identical to one made before the feature existed, so nothing that ignores this page can be affected by anything on it.

What the word never covers is a **trust boundary**. Inputs that are server-owned stay server-owned on every call — experimental or not — and that is enforced at the mint, not by convention. If a capability lets a conversation change something, the bounds are still yours to write and still unreachable from a browser.

### The register

Everything currently experimental, in full. When this list changes, this page changes with it — the plan bullet and this table read the same register.

#### Runtime edit

The set behind your character is re-dressed while the call is running, following the conversation within a brief you write.

| Turn it on | `video.edits.live` — see [the reference](https://realtimeavatar.ai/docs/video#letting-the-look-follow-the-conversation) |
| --- | --- |
| Today | Accepted and carried end to end: the call connects and runs normally, and your brief is applied to the session. The re-dress itself does not reach every capacity tier yet, so a call may run to the end on its opening set. Nothing fails and nothing is charged differently when it does. |
| Included with | Studio and above |

### Using one

Experimental capabilities are configured exactly like stable ones — in your `session` policy, server-side, next to your key. There is no separate endpoint, header or flag to set:

```ts
session: async ({ avatarId }) => ({
  instructions: character.prompt,
  video: {
    edits: {
      instruction: "her studio at golden hour",   // stable: the opening set
      live: {                                     // experimental: runtime edit
        rules: "only change the room and the light, never her face or clothes",
        cooldownSeconds: 30,
      },
    },
  },
})
```

Because the opt-in is a field rather than an account setting, you can ship a call path that uses one and a call path that does not, in the same app, on the same avatar.

### Telling us it went wrong

These are the surfaces we most want to hear about, and the ones where a small report is worth the most. Include the `session_id` from the grant — it is the one handle that finds a specific call.
