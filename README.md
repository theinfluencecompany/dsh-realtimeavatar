# dsh-realtimeavatar

[![ci](https://github.com/cndn/dsh-realtimeavatar/actions/workflows/ci.yml/badge.svg)](https://github.com/cndn/dsh-realtimeavatar/actions/workflows/ci.yml)

**[Realtime Avatar](https://realtimeavatar.ai) for the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh): the developer's API key held by the harness, the public docs as on-demand skills, `rta_*` tools over the public REST API, and a `/rta` command that walks a developer from no key to a live call.**

Realtime Avatar puts a live AI character on a voice or video call. The developer surface is the [`realtime-avatar`](https://www.npmjs.com/package/realtime-avatar) npm SDK ([source](https://github.com/theinfluencecompany/realtime-avatar-sdk)) and a REST API at `https://realtimeavatar.ai/api/v1`. Driving that from a coding agent usually means pasting an API key into chat, re-explaining the documentation every session, and letting the agent call endpoints that spend credits without anyone noticing. This plugin gives the harness the avatar as a primitive instead: the key is a credential *reference* the harness resolves per call and the model never sees; the documentation is five skills the model loads when they are relevant; the API is eighteen typed tools behind a write-approval gate; and `/rta` does onboarding without the model in the loop.

Writes are enabled by default but approval-gated, and anything that spends credits always asks. `readOnly:true` turns every write off.

## What you get

### Tools

Read tools run without approval and are marked concurrency-safe, so the harness may run them in parallel. `rta_docs` and `rta_quickstart` need no key at all.

| Tool | Scope | What it does |
|---|---|---|
| `rta_status` | credits:read, realtime:write | Self-check: whether a key is configured (source and live/test tag, never the value), the credit balance, live capacity, the write posture, and what to do next. Run it first when something is off. |
| `rta_balance` | credits:read | Credit balance: available, reserved and lifetime credits, with an approximate number of minutes on air (1 credit = 1 second). |
| `rta_capacity` | realtime:write | Live-call capacity snapshot: free and active slots, queue depth, whether admission is open, recommended retry delay. Informational only — it does not predict whether a mint will be granted, so never gate a mint on it; mint, and treat a `queued` answer as the signal. |
| `rta_avatars` | avatars:read | List the workspace's avatars with `status` and `idleVideoStatus` (most recently updated first, capped at 100). |
| `rta_avatar` | avatars:read | Fetch one avatar. The tool to poll every few seconds after `rta_avatar_create` until `status` is `ready`. |
| `rta_clips` | avatars:read | An avatar's motion-clip library (`clipId`, role, status, `whenHint`) plus the `revision` that `rta_clips_set` can compare against. |
| `rta_assets` | avatars:read | List uploaded assets; an image asset id is what `rta_avatar_create` takes as `sourceAssetId`. |
| `rta_usage` | usage:read | Billed sessions: trailing 30 days by default, clamped to 90, paged by cursor, narrowable to one end user. Each row carries `activeSeconds` (the spec field), `avatarName` and `endUserId` (taken from `metadata.user_id`). Only `released` and `failed` rows are settled, and the totals sum those rows only. |
| `rta_session_release` | realtime:write | Free a minted call's slot early. Free of charge and idempotent, which is why it sits in the read tier. |
| `rta_docs` | none | The current markdown of one public documentation page: the 14 doc pages plus `index` (llms.txt) and `openapi` (an operation table). Optional `heading` returns one section. |
| `rta_quickstart` | none | The integration page for one framework (`nextjs`, `tanstack-start`, `express`, `hono`, `react`) with the server-half and client-half code skeletons extracted; falls back to the shipped snapshot when offline. |

Write-free tools change state but spend no credits. They ask for approval by default and run without a prompt only when `writeApproval:false`.

| Tool | Scope | What it does |
|---|---|---|
| `rta_asset_remote` | avatars:write | Register a file the platform fetches by absolute http(s) URL as an asset (`image`, `video` or `audio`). |
| `rta_avatar_update` | avatars:write | Partially update an avatar: display name, default voice, `llmProvider` and model, persona, art direction, `stylePreset`, settings, metadata, `anchorTimeMs`. `llmProvider` and `stylePreset` are closed enums: `local`, `gemini`, `openai` and `cinematic-founder`, `editorial-companion`, `warm-anime`, `luxury-realism`, `soft-3d`, `noir-avatar`. A portrait swap is its own lane: pass `sourceAssetId` (an image asset) alone, optionally with `anchorTimeMs` — it is exclusive of every other field. |
| `rta_avatar_delete` | avatars:write | Soft-delete an avatar; it disappears from every read afterwards. |

Write-costly tools spend credits and **always** ask for approval, whatever `writeApproval` says.

| Tool | Scope | What it does |
|---|---|---|
| `rta_avatar_create` | avatars:write | Create an avatar from a portrait image asset (one generation). Returns `preprocessing`; poll `rta_avatar` until `ready`. |
| `rta_loop_set` | avatars:write | Re-render an avatar's resting loop from a new motion prompt (one generation). Needs a portrait on the avatar (422 `loop_not_generatable` otherwise); do not gate on `sourceKind` — a ready avatar reads `video` once its generated loop attaches. Sends an `Idempotency-Key` so a retry never renders twice. |
| `rta_clips_set` | avatars:write | Declare the full clip library: new clips render, matching ones are kept, dropped ones retire, and an empty array retires every clip. At most 12 entries; each `clipId` matches `^[a-z0-9][a-z0-9_-]*$` (≤64 chars), `whenHint` is ≤280 chars, `durationSeconds` is an integer 4–8, and `source` is `{ motionPrompt }` or `{ assetId }`. `Idempotency-Key` plus an optional compare-and-swap on `expectedRevision`. |
| `rta_session_mint` | realtime:write | Mint a live call session: reserves a capacity slot and bills once a client joins. Policy fields: `instructions` (≤4000 chars), `initialContext` (≤32 messages), `maxSessionSeconds` (capped by config), `mode` (`avatar` or `voice`), `voiceId` (a voice id, sent as `voice_id`) or `voice` (a full object `{ provider, voice_id, … }`), `clientMetadata` (≤16 string pairs, keys ≤64 chars, values ≤200), `transcriptWebhook` (`url` https and ≤500 chars, `secret` 16–200). A capacity-full answer comes back as `queued` with a ticket, not as an error. The participant token is withheld unless `includeToken:true`, which returns it and renders it in the chat text. Release with `rta_session_release`. |

Every tool forwards the harness's cancellation signal to the HTTP request, so a cancelled or timed-out call aborts the request instead of running on in the background; the harness reports it as its ABORTED outcome. Three public operations are deliberately not exposed: `POST /api-keys` (mint keys in the dashboard), `POST /assets` (multipart upload — use `rta_asset_remote`) and the deprecated `POST /avatars/{avatarId}/clips`.

Upstream errors are parsed for their message and code and mapped to a kind. A 403 is not only a missing scope: an inactive workspace answers 403 too, and so does the `clip_library_not_enabled` rollout gate on the clip endpoints — read the error text first before minting a wider key.

### Skills

Five skills carry a dated snapshot of the 14 public documentation pages. Only the name and description sit in the catalog; the body loads when the model calls the `skill` tool or you type `/<skill-name>`.

| Skill | Pages |
|---|---|
| `realtimeavatar-quickstart` | overview, quickstart, authentication — preceded by a verified key-facts header: plans, scopes, key format, the public agent prompt |
| `realtimeavatar-integrate` | Next.js, TanStack Start, Express, Hono/Workers/Bun/Deno, React and React Native |
| `realtimeavatar-avatars` | creating an avatar, editing a character |
| `realtimeavatar-calls` | calls (the session policy, the five client states), tool calling, experimental features |
| `realtimeavatar-api` | the API reference — preceded by the operation table with each endpoint's scope, credit cost and the `rta_*` tool that wraps it |

### The `/rta` command

Runs without the model in the loop.

```
/rta setup           — how to get a key and make the first call
/rta key <tic_…>     — store your API key in the harness credential store (not recorded in the session log; never shown to the model)
/rta key             — key posture (source, live/test tag; never the value)
/rta key clear       — remove the stored key
/rta status          — key, credits, capacity, write posture
/rta prompt          — the public "build my first app" prompt for a coding agent
/rta docs [page]     — the public documentation pages
```

`/rta key` is registered with `recordInput:false` and runs without the model, so the pasted key is not recorded in the session log and is never shown to the model. The web composer does keep its draft in browser localStorage while you type; if that matters, export `REALTIME_AVATAR_API_KEY` in the launching shell instead. `/rta key clear` removes only the credential-file entry and reports what still supplies the key afterwards.

`/rta` is available in interactive profiles (the web UI). Headless and one-shot runs have no command surface: export `REALTIME_AVATAR_API_KEY` in the shell that launches dsh, or add the entry to `$DSH_HOME/.credentials.yaml` as shown under [Where the key lives](#where-the-key-lives).

### System-prompt guidance

One short section (`tool:rta`) tells the model that the `rta_*` tools exist and what they cover; which skill to load before designing an integration and that `rta_docs` has the current text; that the key is held by the harness under a credential reference and must never be requested in chat, printed, or put in client code (no `NEXT_PUBLIC_`/`VITE_` names); that a tool reporting `RTA_KEY_MISSING` means "run `/rta setup` in the web UI, or export the variable before launching dsh"; that `seed-rin-ashfall` is a public example avatar any key can call, so a first app never waits on creating one; which tools spend credits; and that every minted session must be released. The documentation itself never goes into the prompt.

## Install

The profile directory is a pnpm workspace root, so pnpm needs `-w`:

```bash
dsh plugin --profile web add -w dsh-realtimeavatar
```

Or during development, from a local checkout:

```bash
cd dsh-realtimeavatar && npm install && npm run build
dsh plugin --profile web add -w /absolute/path/to/dsh-realtimeavatar
```

Installing straight from git (`github:cndn/dsh-realtimeavatar`) builds `lib/` through the `prepare` script. pnpm blocks the prepare build until you allow it once: add the entry pnpm prints under `allowBuilds` in the profile's `pnpm-workspace.yaml` (older pnpm 10 prints an `onlyBuiltDependencies` line instead), then re-run the install.

Node 22.13 or newer. The plugin has no runtime dependencies.

## Get a key in five minutes

This is the same path `/rta setup` prints.

1. **Sign up** for the free Sandbox plan at <https://realtimeavatar.ai/signup>: $0 a month, 1,020 credits (about 17 minutes on air), 1 concurrent stream, 1 avatar, no card. 1 credit = 1 second on air; live conversation lands around $5 per hour. Plans: <https://realtimeavatar.ai/pricing>.
2. **Open the dashboard** at <https://realtimeavatar.ai/platform/dashboard>. API keys live under <https://realtimeavatar.ai/platform/settings#api-keys>.
3. **Create a key.** It is shown once and looks like `tic_test_…` or `tic_live_…`. The tag is organisational, not a sandbox — both spend the same credits. Dashboard keys start with every scope except `*`: untick what this key should not do (especially `api_keys:write`) and set a per-key spend limit.
4. **Store it** with `/rta key tic_…` in the web UI. It goes to `$DSH_HOME/.credentials.yaml` under `REALTIME_AVATAR_API_KEY`; the command runs without the model and is not recorded in the session log. Alternatively `export REALTIME_AVATAR_API_KEY=…` in the shell that launches dsh — the only route for headless runs, which have no `/rta`. Never a `NEXT_PUBLIC_`/`VITE_` name: the key stays on your server.
5. **Verify** with `/rta status`: credits, capacity, key tag.
6. **Build.** `npm install realtime-avatar`, then hand your agent `/rta prompt`, which is the public prompt the dashboard shows next to a new key:

   ```text
   Build a one-button page that opens a live video call with the example avatar Rin (seed-rin-ashfall): she speaks first, two-way voice, her portrait while she connects, a hang-up button. Stop there for testing. Key in REALTIME_AVATAR_API_KEY. Follow https://realtimeavatar.ai/llms.txt.

   Optional — to use your own avatar instead: create Nova from nova.png with a warm mid-pitch voice, poll until ready, and repoint the same button at her without changing the page.
   ```

   It starts on the public example avatar `seed-rin-ashfall`, so nothing waits on creating one. The agent can load `realtimeavatar-quickstart` / `realtimeavatar-integrate` or call `rta_quickstart` for its framework.
7. **Your own avatar.** Register a portrait with `rta_asset_remote`, create it with `rta_avatar_create` (spends credits, asks first), poll `rta_avatar` until `ready`, swap the id.

Public plans, as published on the pricing page:

| Plan | $/mo | Credits | ≈ minutes | Concurrent streams | Avatars | Note |
|---|---|---|---|---|---|---|
| Sandbox | 0 | 1,020 | 17 | 1 | 1 | no card; enough for a first avatar plus a few minutes of calls |
| Starter | 9 | 7,200 | 120 | 2 | 5 | overage $0.095/min |
| Developer | 24 | 36,000 | 600 | 5 | 25 | overage $0.085/min |
| Studio | 119 | 180,000 | 3000 | 20 | 100 | overage $0.08/min; experimental features |

Scopes, as documented on the authentication page:

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

A key for this plugin needs `realtime:write`, `avatars:read`, `credits:read` and `usage:read` for the read tools, plus `avatars:write` if you intend to create or edit avatars. It never needs `api_keys:write` or `*`.

## Configure

The package already inserts a `realtimeavatar` row into your profile. Override its `config` from your profile's `cordis.patch.yml` with an **id-targeted entry** — not a second `insert` entry, which would load the plugin twice. **The API key is never part of this config**; see the next section.

```yaml
- id: realtimeavatar
  name: 'dsh-realtimeavatar'
  config:
    apiKeyEnv: REALTIME_AVATAR_API_KEY   # credential REFERENCE (an env-var-style name), never the key itself
    readOnly: false                      # default false; true denies every write tool
    writeApproval: true                  # default true; false lets write-free tools run unprompted (credit-spending tools still ask)
    maxSessionSeconds: 300               # cap applied to rta_session_mint (1–1800, clamped)
    requestTimeoutMs: 30000              # per API request (5 s – 2 min, clamped)
    docsTimeoutMs: 20000                 # per docs fetch (5 s – 2 min, clamped)
    docsMaxChars: 24000                  # output cap for rta_docs / rta_quickstart (2000–200000, clamped)
```

`apiKeyEnv` must be an environment-variable-style name (letters, digits, underscore). A value that starts with `tic_` is rejected: `apiKeyEnv` names the credential, it never holds the key. The booleans must be booleans; the numbers must be positive and are rounded and clamped into their ranges. If the config is invalid the plugin logs one warning at boot, runs on the defaults, and `rta_status` / `/rta status` print the config error. A copy of this entry with comments is in [`examples/cordis.patch.yml`](examples/cordis.patch.yml).

## Where the key lives

`apiKeyEnv` is a credential **reference**, by default `REALTIME_AVATAR_API_KEY` — the same name the public documentation uses everywhere. The value behind it is resolved per call and never at boot.

- **Credential store.** When dsh composes its credential service, the value is resolved through it. The store layers four sources, and the first one that has the name wins:
  1. the environment of the process that launched dsh — read-only, always wins;
  2. `$DSH_HOME/.credentials.yaml` — the file `/rta key` writes;
  3. a `.env` in the working directory (reported as `project-env`);
  4. a `.env` in the dsh home (reported as `user-env`).
- **`/rta key tic_…`** validates the shape (`tic_live_…` or `tic_test_…`, printable ASCII, no whitespace), writes the credential file, and answers with the tag and the length only. It runs without the model and is registered with `recordInput:false`, so the pasted key is not recorded in the session log and is never shown to the model. The web composer keeps its draft in browser localStorage while you type; if that matters, export `REALTIME_AVATAR_API_KEY` in the launching shell instead. A name already supplied by the launching environment is read-only: the command refuses to overwrite it (`RTA_KEY_SHADOWED`).
- **`/rta key clear`** removes only the credential-file entry and reports what still supplies the key afterwards (for example `project-env`, the `.env` in the working directory). A key supplied by the launching environment cannot be cleared from here.
- **Headless.** `/rta` exists only in interactive profiles (the web UI); headless and one-shot runs have no command surface. Export `REALTIME_AVATAR_API_KEY` in the launching shell, or add the entry to `$DSH_HOME/.credentials.yaml` (mode 600):

  ```yaml
  version: 1
  refs:
    REALTIME_AVATAR_API_KEY: tic_…
  ```

- **No credential service.** A profile without one reads the reference straight from the environment that launched dsh; `/rta key` answers `RTA_KEY_STORE_UNAVAILABLE` there.
- **Never rendered.** The value lives only in the request closure. `rta_status` and `/rta key` report where the key came from and whether it is a live or test key, never the value. A missing key surfaces as `RTA_KEY_MISSING` with the instruction to run `/rta setup` in the web UI, or to export the variable before launching dsh.

Never put the key in client code. It authorizes calls and generations against your credits; the SDK's route adapters keep it on the server, and a `NEXT_PUBLIC_`/`VITE_` name ships it to every browser.

## Safety

The `tools/pre-execute` gate decides per tool tier:

| Tier | Tools | `readOnly:true` | `writeApproval:true` (default) | `writeApproval:false` |
|---|---|---|---|---|
| read | `rta_status`, `rta_balance`, `rta_capacity`, `rta_avatars`, `rta_avatar`, `rta_clips`, `rta_assets`, `rta_usage`, `rta_session_release`, `rta_docs`, `rta_quickstart` | allow | allow | allow |
| write-free | `rta_asset_remote`, `rta_avatar_update`, `rta_avatar_delete` | deny | ask | allow |
| write-costly | `rta_avatar_create`, `rta_loop_set`, `rta_clips_set`, `rta_session_mint` | deny | ask | ask (always) |

- **The gate is one link in the harness's chain.** dsh runs its `tools/pre-execute` listeners in order and each one may pass the call on with `next()`. The plugin never force-allows: "allow" above means reads — and free writes when `writeApproval:false` — are passed down the chain, so a later policy plugin (plan mode, a deployment policy) still sees them. For an approval ask it calls `next()` first and a downstream deny wins over its prompt. `readOnly:true` denies immediately, before anything else runs; each write tool refuses again at execute time as a second layer.
- **Approval** goes through dsh's approval service. In the web UI you get a confirmation card with a redacted one-line description of the write (tool, avatar id, prompt length, clip count, session cap). Where nobody can answer — a headless profile without an interactive answerer, a profile with no approval service, or `DSH_PERMISSION_MODE=danger-full-access` (dsh sets the approval policy to `never`) — the ask is auto-denied. In those modes credit-spending tools cannot run at all, and write-free tools run only with `writeApproval:false`.
- **`writeApproval:false`** lifts the gate for the three write-free tools only; the plugin logs one warning at boot when both flags are off.
- **Redaction.** Any token shaped like `tic_live_…` / `tic_test_…` and any `Bearer` value is redacted in every error message, rendered tool output, approval reason and command result; the exact key of the request is scrubbed as well. Upstream error bodies are parsed for their message and code — the raw response text is never surfaced.
- **The participant token is withheld by default.** `rta_session_mint` returns the session without its joinable participant token unless `includeToken:true` is passed explicitly. With it, the token is returned in the result *and* rendered in the chat text, where the model and the transcript see it — ask for it only when you mean to join from here.
- **Sessions must be released.** A minted session holds a capacity slot and bills once a client joins. Call `rta_session_release` with the `sessionId` (or `queueTicketId`) when done; the reservation also expires on its own. `maxSessionSeconds` is capped by config (default 300 s) on top of whatever the call asks for.
- **Retries never render twice.** `rta_loop_set` and `rta_clips_set` send an `Idempotency-Key` (auto-generated unless you pass one). A key you pass yourself must be at most 180 header-safe characters (letters, digits, `.`, `_`, `:`, `-`); the API ignores longer keys, which would defeat the protection.
- **Inputs are narrowed** before they reach a URL: ids must be letters, digits, dot, underscore or dash; remote asset URLs must be absolute http(s); the wire schemas' size limits (instructions, context messages, metadata pairs, clip fields, webhook URL) are enforced locally, and a request body over 1 MB is refused before it leaves the process.
- **A `tic_test_` key is not a sandbox.** It spends the same credits as a `tic_live_` key. The free Sandbox plan is the way to try things without paying.

## Docs and freshness

The five skills are a **dated snapshot** of the public documentation. Each file's frontmatter records `snapshot: YYYY-MM-DD` and the source pages, and the body opens with the date. The public pages change often — their `Updated` stamps move almost daily — so treat the snapshot as a starting point and `rta_docs`, which fetches the live page, as authoritative. `npm run sync-docs -- --check` shows how far the shipped snapshot has drifted from the live pages.

The snapshot is regenerated by `npm run sync-docs` at release time, not at build time: the script fetches the 14 public pages and `openapi.json`, validates each page's shape (title line, footer, minimum size), refuses to write when the operation table in `src/facts.ts` drifts from the live spec, runs the leak gate over the generated text, and writes each file through a temp file and rename so a failure never leaves a half-updated snapshot. The `realtimeavatar-api` skill embeds the operation table. Bundled skills rank below every skill discovery root, so a copy in your own skills directory shadows the bundled one.

When freshness matters, `rta_docs` fetches the **live page** on every call. It accepts only the closed slug set (the 14 pages plus `index` and `openapi`), never an arbitrary URL; strips the site footer; returns one section on request; and caps the output at the per-call `maxChars`, itself capped by `docsMaxChars`. `rta_quickstart` fetches live too and reports `source: live` or `source: snapshot` when it had to fall back.

Public machine-readable entry points:

- Agent guide: <https://realtimeavatar.ai/llms.txt> (and the full text at <https://realtimeavatar.ai/llms-full.txt>)
- OpenAPI: <https://realtimeavatar.ai/openapi.json>
- Documentation: <https://realtimeavatar.ai/docs> — append `.md` to any page for markdown

The hand-maintained facts (URLs, plans, scopes, the operation table, the error table, the agent prompt) live in `src/facts.ts` with the date they were last verified against the live site.

## License

MIT
