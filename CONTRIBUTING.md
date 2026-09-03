# Contributing

## Setup

```bash
npm install
npm test          # builds lib/ with tsc, then runs node --test over test/*.test.mjs
npm run typecheck
```

Node 22.13 or newer. There are no runtime dependencies; keep it that way — the
plugin must load in any dsh profile without pulling extra packages.

## Tests

`npm test` runs every `test/*.test.mjs` against stubbed responses; nothing in
the default run touches the network or needs a key. Fixtures live in
`test/fixtures/` (a captured `openapi.json` and a docs page with the site
footer).

The harness-contract test can also run dsh's own JSON-schema acceptance over
every tool definition. Point `DSH_TOOLS_ENTRY` at an installed
`@deepseek-ai/dsh-tools`; without it those checks are skipped, which is what
CI does.

```bash
DSH_TOOLS_ENTRY=<dsh profile>/node_modules/@deepseek-ai/dsh-tools/lib/index.js npm test
```

## Scripts

- `npm run leak-gate` — packs the package with `npm pack`, extracts the
  tarball and scans every shipped file (`lib/`, `skills/`, the bundle patch,
  the README) for anything that is not the public realtimeavatar.ai surface.
  Exit 1 on any finding. Two kinds of rule live in `scripts/leak-gate.mjs`:
  - *generic patterns*, which are public: 32-hex and UUID ids, key-shaped
    strings, vendor avatar ids, private hosts (workers, storage, media
    registries), pre-production environment names, local `/home/…` and
    `/Users/…` paths, and MCP claims (the plugin makes none). Each pattern
    carries a sample it must match; a self-check runs before every scan.
  - *private vocabulary*, held only as salted SHA-256 digests of lower-cased
    tokens. The file never spells the words it guards against; every
    separator-delimited substring of each token run in a line is digested and
    compared. To add a word, add `digest(word)` to the set, never the word.

  Files under `skills/` get one exact-phrase allowance
  (`SKILL_ALLOW_PHRASES`) for public documentation text that happens to match a
  pattern; everything else is scanned strictly. `prepublishOnly` and CI run the
  gate; `node scripts/leak-gate.mjs <dir>` scans an already extracted
  directory, and `scripts/sync-docs.mjs` runs the same `scan()` over generated
  skill text before writing it.
- `npm run proof` — a real-runtime proof: loads the built plugin into an
  installed dsh rather than a stub. Needs a dsh installation on the machine.
- `npm run smoke` — an env-driven, read-only live smoke against the public API.
  `REALTIME_AVATAR_API_KEY` must be a `tic_test_` key. It issues GET requests
  only, so it spends nothing. (A test key is not a sandbox; it is the read-only
  nature of the script that keeps it free.)

```bash
REALTIME_AVATAR_API_KEY=tic_test_… npm run smoke
```

## Syncing the docs (release step)

`skills/*.md` is a snapshot of the public documentation and is regenerated at
release time, never at build time. The public pages change often (their
`Updated` stamps move almost daily), so re-run the sync before every release
and review the diff:

```bash
npm run build
npm run sync-docs            # fetch, validate, check, write skills/
npm run sync-docs -- --check # exit 1 if skills/ differ from the live pages
```

What the script does, in order:

1. Fetches the 14 public pages listed in `src/facts.ts` plus `openapi.json`
   (three at a time, three attempts each).
2. Validates each fetched page's shape — a markdown title line, the public
   site footer, and a minimum size — and refuses to snapshot anything that
   fails; an upstream hiccup must not overwrite a good snapshot.
3. Checks that the operation table in `src/facts.ts` matches the live spec and
   refuses to write on drift (exit 2). Update `OPERATIONS` and the tools first,
   then regenerate. The `realtimeavatar-api` skill embeds that operation table
   together with the one derived from the live OpenAPI document.
4. Runs the leak gate over the generated text and enforces a per-skill size
   limit.
5. Writes each skill through a temp file and rename, so a failure mid-loop
   never leaves a half-updated `skills/`.

`--check` writes nothing and reports which skills have drifted from the live
pages, ignoring the snapshot-date lines. CI runs it as an informational
`docs-drift` job that needs the network and never fails the build.

Every public fact the plugin states — URLs, plans, scopes, the key format, the
operation table, the error table, the agent prompt — is hand-maintained in
`src/facts.ts` with the date it was last verified. Change it there, not in the
places that render it.

## Commits and releases

Conventional Commits with a lowercase subject (`fix: …`, `feat: …`, `docs: …`).

1. `npm run build && npm run sync-docs`; review and commit the skills diff.
2. Bump `version` in `package.json` and `PLUGIN_VERSION` in `src/config.ts`
   (a test keeps them equal).
3. Update the `CHANGELOG.md` entry.
4. `npm test && npm run leak-gate`.
5. Tag `vX.Y.Z` and publish. `prepublishOnly` builds `lib/` and runs the leak
   gate; the tarball ships only `lib/`, `skills/`, the bundle patch, README and
   LICENSE.
