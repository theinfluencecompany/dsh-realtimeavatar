# Changelog

All notable changes to dsh-realtimeavatar are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - unreleased

### Added

- Eighteen Cordis tools for the DeepSeek Harness over the public Realtime Avatar
  REST API (`https://realtimeavatar.ai/api/v1`): eleven reads (`rta_status`,
  `rta_balance`, `rta_capacity`, `rta_avatars`, `rta_avatar`, `rta_clips`,
  `rta_assets`, `rta_usage`, the free idempotent `rta_session_release`,
  `rta_docs`, `rta_quickstart`), three write-free tools (`rta_asset_remote`,
  `rta_avatar_update`, `rta_avatar_delete`) and four credit-spending tools
  (`rta_avatar_create`, `rta_loop_set`, `rta_clips_set`, `rta_session_mint`).
- A `tools/pre-execute` gate by tier: reads and, under `writeApproval:false`,
  free writes are passed down the harness chain with `next()` so later policy
  plugins still see them (the plugin never force-allows); write-free tools ask
  for approval by default; credit-spending tools always ask; for an ask a
  downstream deny wins; `readOnly:true` denies every write immediately, with a
  second refusal at execute time.
- The API key as a credential reference (`apiKeyEnv`, default
  `REALTIME_AVATAR_API_KEY`) resolved per call through the harness credential
  store — launch environment (read-only) over `$DSH_HOME/.credentials.yaml`
  over the project and user `.env` files — or, without a store, the launch
  environment. Never part of the config (a value starting with `tic_` is
  rejected), never resolved at boot, never rendered. Coded key errors
  (`RTA_KEY_MISSING`, `RTA_KEY_INVALID`, `RTA_KEY_SHADOWED`,
  `RTA_KEY_STORE_UNAVAILABLE`); the missing-key message says to run
  `/rta setup` in the web UI or export the variable before launching dsh.
- The `/rta` command (`setup`, `key`, `key clear`, `status`, `prompt`,
  `docs [page]`, `help`) for interactive profiles. It runs without the model and
  is registered with `recordInput:false`, so a pasted key is not recorded in the
  session log and is never shown to the model. `/rta key clear` removes only the
  credential-file entry and reports what still supplies the key afterwards.
- Five skills carrying a dated snapshot of the 14 public documentation pages:
  `realtimeavatar-quickstart`, `realtimeavatar-integrate`,
  `realtimeavatar-avatars`, `realtimeavatar-calls`, `realtimeavatar-api` (the
  last embeds the operation table).
- A short system-prompt section (`tool:rta`) naming the tools and skills, the
  key-handling rule, the public example avatar `seed-rin-ashfall`, the tools that
  spend credits, and the obligation to release minted sessions.
- Redaction of every `tic_live_…` / `tic_test_…` shaped token and every `Bearer`
  value in errors, rendered output, approval reasons and command results;
  upstream error bodies are parsed, never echoed raw. 403 answers distinguish a
  missing scope, an inactive workspace and the `clip_library_not_enabled`
  rollout gate.
- `rta_session_mint` takes `voiceId` (sent as `voice_id`) or a full `voice`
  object, `clientMetadata` (≤16 pairs, keys ≤64 / values ≤200 chars) and an
  https `transcriptWebhook` (url ≤500 chars); caps `maxSessionSeconds` by config
  (default 300 s, at most 1800); returns a capacity-full answer as `queued`
  rather than an error; and withholds the participant token unless
  `includeToken:true`, which returns and renders it.
- `rta_avatar_update` with closed `llmProvider` and `stylePreset` enums and a
  separate portrait-swap lane (`sourceAssetId`, exclusive of everything but
  `anchorTimeMs`). `rta_clips_set` validates `clipId`, `whenHint` and
  `durationSeconds` locally, accepts an empty array to retire the library, and
  caps it at 12 entries. `rta_loop_set` and `rta_clips_set` send an
  `Idempotency-Key` (≤180 header-safe chars when supplied). `rta_usage` rows
  carry `activeSeconds`, `avatarName` and `endUserId`; totals cover settled rows
  only. `rta_capacity` is informational and never gates a mint.
- Every tool forwards the harness cancellation signal to the HTTP request;
  cancelled calls settle as dsh's ABORTED outcome.
- `rta_docs` fetches only the closed public page set (14 pages, `index` =
  llms.txt, `openapi` = operation table) with a per-call and per-config output
  cap; `rta_quickstart` falls back to the shipped snapshot offline.
- Release tooling: `npm run sync-docs` regenerates `skills/` from the live
  public pages — validating each page's shape, refusing on OpenAPI operation
  drift, running the leak gate, writing via temp file and rename — and
  `--check` reports snapshot drift; `npm run leak-gate` scans the packed tarball
  with generic public patterns plus a salted-digest private-vocabulary list;
  `prepublishOnly` and CI run it.
- Zero runtime dependencies; MIT license.
