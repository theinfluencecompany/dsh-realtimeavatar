// Package manifest, bundle patch and README: what the marketplace and
// `dsh plugin add` rely on, and that nothing key-shaped ships.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PLUGIN_VERSION } from '../lib/config.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'))

test('package identity', () => {
  assert.equal(pkg.name, 'dsh-realtimeavatar')
  assert.equal(pkg.type, 'module')
  assert.equal(typeof pkg.version, 'string')
  assert.match(pkg.version, /^\d+\.\d+\.\d+/)
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.engines?.node, '>=22.13')
  assert.equal(typeof pkg.description, 'string')
  assert.equal(typeof pkg.bugs?.url, 'string')
})

test('PLUGIN_VERSION (the User-Agent) tracks package.json', () => {
  assert.equal(PLUGIN_VERSION, pkg.version)
})

test('exports and files are wired for publish', () => {
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.types, 'lib/index.d.ts')
  assert.deepEqual(pkg.exports['.'], { types: './lib/index.d.ts', default: './lib/index.js' })
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.exports['./package.json'], './package.json')
  for (const entry of ['lib', 'skills', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(entry), 'files must include ' + entry)
  }
  for (const script of ['prepare', 'prepublishOnly', 'test', 'sync-docs', 'leak-gate', 'typecheck', 'build']) {
    assert.equal(typeof pkg.scripts?.[script], 'string', 'scripts.' + script + ' must exist')
  }
  // lib/ is gitignored, so git-hosted installs must build it on install.
  assert.match(pkg.scripts.prepare, /tsc -p tsconfig\.json/)
  assert.match(pkg.scripts.prepublishOnly, /leak-gate\.mjs/, 'publishing must run the leak gate')
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'zero runtime dependencies')
  assert.ok(existsSync(root + 'LICENSE'))
})

test('marketplace keywords are present', () => {
  assert.ok(Array.isArray(pkg.keywords))
  for (const kw of ['dsh-plugin', 'realtime-avatar', 'deepseek-harness', 'dsh']) {
    assert.ok(pkg.keywords.includes(kw), 'missing keyword ' + kw)
  }
})

test('dsh bundle patch points at the shipped cordis.patch.yml', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(root + 'cordis.patch.yml'), 'cordis.patch.yml must exist')
})

test('the bundled patch inserts the realtimeavatar row with the public credential reference and no key value', () => {
  const patch = readFileSync(root + 'cordis.patch.yml', 'utf8')
  assert.match(patch, /^- insert:\n\s+- id: realtimeavatar\n\s+name: 'dsh-realtimeavatar'\n\s+config:\n\s+apiKeyEnv: REALTIME_AVATAR_API_KEY/m)
  assert.equal((patch.match(/^- insert:/gm) ?? []).length, 1, 'exactly one insert')
  assert.match(patch, /readOnly: false/)
  assert.match(patch, /writeApproval: true/)
  // Any `tic_` in the patch is the ellipsis placeholder in a comment, never a value.
  assert.doesNotMatch(patch, /tic_(?!…)/, 'key-shaped material in the bundled patch')
  assert.doesNotMatch(patch, /Bearer\s+\S/i)
  assert.doesNotMatch(patch, /REALTIME_AVATAR_API_KEY\s*[:=]\s*\S/, 'the reference is a name, never assigned a value')
})

test('the README (once written) documents the -w install flag and the id-targeted override', { skip: !existsSync(root + 'README.md') && 'README.md not written yet' }, () => {
  const readme = readFileSync(root + 'README.md', 'utf8')
  assert.match(readme, /dsh plugin --profile web add -w dsh-realtimeavatar/)
  assert.match(readme, /- id: realtimeavatar/)
  assert.doesNotMatch(readme, /^- insert:/m, 'README must not tell users to insert a second realtimeavatar row')
  assert.doesNotMatch(readme, /tic_(live|test)_[A-Za-z0-9]/, 'README must not show a key-shaped value')
})
