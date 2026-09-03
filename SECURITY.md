# Security policy

## What dsh-realtimeavatar promises

- **Key hygiene.** The plugin config carries only a credential *reference*
  (`apiKeyEnv`, an env-var-style name), never the API key; a config value that
  starts with `tic_` is rejected at boot. The value is resolved per call through
  the harness credential service (launch environment, then
  `$DSH_HOME/.credentials.yaml`, then the project and user `.env` files) or,
  without a service, the launch environment. It is validated as
  `tic_live_…` / `tic_test_…` printable ASCII, lives only in the request
  closure, and is never resolved at boot, stored on an object, logged, rendered
  to the model, or included in an error message. `/rta key` runs without the
  model and is registered with `recordInput:false`, so the pasted key is not
  recorded in the session log and is never shown to the model. A value supplied
  by the launching environment is read-only: `/rta key` refuses to overwrite it
  and `/rta key clear` removes only the credential-file entry, reporting what
  still supplies the key afterwards.
- **Approval gates.** Credit-spending tools (`rta_avatar_create`, `rta_loop_set`,
  `rta_clips_set`, `rta_session_mint`) always go through dsh's approval service,
  whatever the config says. Write-free tools (`rta_asset_remote`,
  `rta_avatar_update`, `rta_avatar_delete`) ask by default and run unprompted
  only with `writeApproval:false`. `readOnly:true` denies every write at the
  gate and again at execute time. The gate never force-allows: reads, and free
  writes under `writeApproval:false`, are passed down the harness's
  `tools/pre-execute` chain so a later policy plugin still sees them, and for an
  approval ask a downstream deny wins. Where no one can answer an ask —
  headless without an approval service, or
  `DSH_PERMISSION_MODE=danger-full-access` — the write is denied, not waved
  through.
- **Redaction.** Every error message, rendered tool output, approval reason and
  command result is passed through a redactor that removes the request's exact
  key, any `tic_live_` / `tic_test_` shaped token and any `Bearer` value.
  Upstream error bodies are parsed for their message and code; the raw response
  text is never surfaced.
- **Bounded docs fetch.** `rta_docs` and `rta_quickstart` fetch only the closed
  set of public realtimeavatar.ai pages named in `src/facts.ts` (plus
  `llms.txt` and `openapi.json`), unauthenticated, with a timeout and an output
  cap. No arbitrary URL can be fetched through them.
- **Joinable credentials stay out of the transcript by default.**
  `rta_session_mint` withholds the participant token unless `includeToken:true`
  is passed explicitly; with it, the token is returned and rendered in the chat
  text.
- **Bounded inputs.** Ids are validated before they enter a request path,
  remote asset URLs must be absolute http(s), transcript webhook URLs must be
  https, and the wire schemas' size limits are enforced locally.
  `rta_session_mint` caps `maxSessionSeconds` by config; request bodies over
  1 MB are refused before they leave the process.
- **A release leak gate.** Every published tarball is scanned by
  `scripts/leak-gate.mjs` before it ships (`prepublishOnly` and CI run it). Two
  kinds of rule: generic public patterns (hex and UUID ids, key-shaped strings,
  private hosts, environment names, local filesystem paths, integration claims
  the plugin does not make) and a list of private vocabulary held only as salted
  digests, so the gate file never spells the words it guards against. The docs
  snapshot under `skills/` gets a single exact-phrase allowance for public text
  that happens to match a pattern; everything else is scanned strictly.

## What it does not promise

- A key that carries write scopes (`avatars:write`, `realtime:write`) **can spend
  credits** through this plugin once an approver says yes — or, for the three
  write-free tools, once `writeApproval:false` is set. Give the plugin a key with
  only the scopes it needs, set a per-key spend limit in the dashboard, and use
  `readOnly:true` for an agent that should only look.
- The web composer keeps its draft in browser localStorage while you type
  `/rta key tic_…`, before the command runs. If that matters on the machine you
  use, export `REALTIME_AVATAR_API_KEY` in the launching shell instead of
  pasting the key into the composer.
- Cancelling `rta_session_mint` abandons the HTTP request only. A reservation
  the platform has already created may exist without the tool ever seeing its
  id; it expires on its own, and `rta_usage` shows it once settled.
- A `tic_test_` key is **not** a sandbox. It spends the same credits as a
  `tic_live_` key; only the free Sandbox plan is free.
- The plugin cannot protect a key that other processes can read from the
  environment or the `.env` file you put it in, or a key a user pastes into
  chat by hand instead of using `/rta key`.
- The leak gate checks what the package ships, not what the live documentation
  says; `npm run sync-docs` runs the same gate over the fetched text before it
  writes a snapshot.

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/cndn/dsh-realtimeavatar/security/advisories/new)
or an issue at <https://github.com/cndn/dsh-realtimeavatar/issues> with a minimal
reproduction. Any path that exposes the API key or the participant token, or that
lets a credit-spending tool run without approval, is treated as critical and
fixed first.
