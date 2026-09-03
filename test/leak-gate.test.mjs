// The leak gate: its generic rules fire on what they must, the salted-digest
// private vocabulary fires without the words being present in the source,
// the documented placeholders are tolerated, and — the real check — nothing
// is found in the files npm would ship.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATTERNS, SELF_CHECK_TOKEN, SKILL_ALLOW_PHRASES, digest, scan, scanDirectory, selfCheck } from '../scripts/leak-gate.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const strictFile = (text) => [{ file: 'lib/x.js', text }]
const skillFile = (text) => [{ file: 'skills/x.md', text }]
const rules = (findings) => findings.map((f) => f.rule)
const HEX_PLACEHOLDER = '0123456789abcdef0123456789abcdef'
const UUID_PLACEHOLDER = '12345678-1234-4123-8123-123456789abc'
const EXPECTED_RULES = [
  'cloudflare-account-or-hex-id',
  'uuid',
  'real-api-key',
  'vendor-avatar-id',
  'mcp-claim',
  'pool-assignment',
  'local-path',
  'placeholder-email',
  'workers-dev-host',
  'canary-environment',
  'staging-environment',
  'github-packages-registry',
  'cloudflare-storage-host',
  'livekit-cloud-host',
]

test('selfCheck passes: every pattern fires on its own sample and the digest path catches the self-check token', () => {
  assert.doesNotThrow(() => selfCheck())
  assert.deepEqual(PATTERNS.map((p) => p.name), EXPECTED_RULES, 'the 14 generic rules, in order')
  for (const p of PATTERNS) {
    assert.equal(typeof p.name, 'string')
    assert.ok(p.re instanceof RegExp, p.name)
    assert.ok(!p.re.global, p.name + ' must not be a /g regex (lastIndex would make exec() stateful)')
    assert.equal(typeof p.sample, 'string', p.name + ' carries a sample')
    assert.ok(rules(scan(strictFile('before ' + p.sample + ' after'))).includes(p.name), p.name + ' does not fire on its sample through scan()')
    assert.ok(rules(scan(skillFile('before ' + p.sample + ' after'))).includes(p.name), p.name + ' does not fire on its sample under skills/')
  }
})

test('the private vocabulary is a salted digest: no literal list is exported and digest() is case-insensitive', async () => {
  const mod = await import('../scripts/leak-gate.mjs')
  assert.equal(mod.LITERALS, undefined, 'no LITERALS export any more')
  assert.equal(mod.STRICT_ONLY_LITERALS, undefined, 'no STRICT_ONLY_LITERALS export any more')
  assert.deepEqual(Object.keys(mod).sort(), ['PATTERNS', 'SELF_CHECK_TOKEN', 'SKILL_ALLOW_PHRASES', 'digest', 'scan', 'scanDirectory', 'selfCheck'])
  assert.equal(SELF_CHECK_TOKEN, 'example-private-token')
  assert.match(digest('abc'), /^[0-9a-f]{64}$/)
  assert.equal(digest('ABC'), digest('abc'), 'digests are computed over the lower-cased token')
  assert.notEqual(digest('abc'), digest('abd'))
  const source = readFileSync(join(root, 'scripts', 'leak-gate.mjs'), 'utf8')
  assert.ok(source.includes(digest(SELF_CHECK_TOKEN)), 'the self-check token is stored as its digest')
})

test('the digest path reports a private word as private-vocabulary with a masked match, inline and inside a URL path segment', () => {
  const inline = scan(strictFile('see ' + SELF_CHECK_TOKEN + ' here'))
  assert.deepEqual(inline, [{ file: 'lib/x.js', line: 1, rule: 'private-vocabulary', match: 'ex…en' }], 'exactly one finding, masked')
  assert.ok(!JSON.stringify(inline).includes(SELF_CHECK_TOKEN), 'the finding never spells the word out')
  const inUrl = scan(strictFile('fetch("https://host.example/' + SELF_CHECK_TOKEN + '/v1?x=1")'))
  assert.deepEqual(rules(inUrl), ['private-vocabulary'])
  assert.equal(inUrl[0].match, 'ex…en')
  const upper = scan(strictFile('SEE ' + SELF_CHECK_TOKEN.toUpperCase() + ' HERE'))
  assert.deepEqual(rules(upper), ['private-vocabulary'], 'case-insensitive')
  assert.equal(scan(strictFile('fine\n\nsee ' + SELF_CHECK_TOKEN))[0].line, 3, '1-based line number')
})

test('the self-check token is not strict-only: it fires under lib/ and skills/ alike', () => {
  // The strict-only word itself is opaque by design (only its digest is stored), so the
  // lib/-vs-skills/ contrast is exercised with the self-check token, which must fire in both.
  for (const file of ['lib/x.js', 'lib/tools/y.js', 'skills/x.md', 'README.md', '/tmp/package/skills/realtimeavatar-api.md']) {
    assert.deepEqual(rules(scan([{ file, text: 'about ' + SELF_CHECK_TOKEN }])), ['private-vocabulary'], file)
  }
})

test('documented placeholders pass', () => {
  const placeholders = [
    '00000000-0000-0000-0000-000000000000',
    '0'.repeat(32),
    'a'.repeat(32),
    'tic_live_…',
    'tic_test_…',
    'tic_test_',
    'tic_live_',
    '`/rta key tic_…`',
    'Authorization: Bearer tic_…',
    'ava_… (your own avatars)',
    'seed-rin-ashfall',
    'REALTIME_AVATAR_API_KEY=… in the shell',
    'capacity_pool: primary',
    'a word like mcpx or mcpserver is fine',
    'https://realtimeavatar.ai/docs · https://realtimeavatar.ai/llms.txt',
    'wss://example.com/rtc',
    'ava_test1 ses_test1 ast_test1',
    'realtime-avatar (the npm SDK) over LiveKit',
  ]
  for (const text of placeholders) assert.deepEqual(scan(strictFile(text)), [], 'placeholder flagged: ' + text)
})

test('key-shaped values, real-looking ids, hosts, environment names and MCP claims are caught in lib/ and skills/', () => {
  const bad = [
    ['tic_test_' + 'x'.repeat(40), 'real-api-key'],
    ['tic_live_abcdef1234', 'real-api-key'],
    ['ava_' + '1234abcd'.repeat(4), 'vendor-avatar-id'],
    [UUID_PLACEHOLDER, 'uuid'],
    [HEX_PLACEHOLDER, 'cloudflare-account-or-hex-id'],
    ['capacity_pool: some-pool', 'pool-assignment'],
    ['capacity_pool = "gpu-a"', 'pool-assignment'],
    ['exposes an MCP server', 'mcp-claim'],
    ['several mcps', 'mcp-claim'],
    ['the Model Context Protocol', 'mcp-claim'],
    ['/home/someone/project/x', 'local-path'],
    ['/Users/someone/project/x', 'local-path'],
    ['ops@test.local', 'placeholder-email'],
    ['https://x.workers.dev/', 'workers-dev-host'],
    ['the canary worker', 'canary-environment'],
    ['deploy to Canary first', 'canary-environment'],
    ['staging-foo', 'staging-environment'],
    ['our STAGING pipeline', 'staging-environment'],
    ['npm.pkg.github.com', 'github-packages-registry'],
    ['x.r2.cloudflarestorage.com', 'cloudflare-storage-host'],
    ['registry.cloudflare.com', 'cloudflare-storage-host'],
    ['wss://x.livekit.cloud', 'livekit-cloud-host'],
  ]
  for (const [text, rule] of bad) {
    assert.ok(rules(scan(strictFile(text))).includes(rule), text + ' should trip ' + rule)
    assert.ok(rules(scan(skillFile(text))).includes(rule), text + ' should trip ' + rule + ' in skills too')
  }
})

test('the skill allow phrases pass under skills/ only, and only as the exact phrase', () => {
  assert.deepEqual(SKILL_ALLOW_PHRASES, ['a staging pipeline that is down'])
  for (const phrase of SKILL_ALLOW_PHRASES) {
    assert.deepEqual(scan(skillFile('…because of ' + phrase + ' upstream')), [], 'skills must tolerate ' + JSON.stringify(phrase))
    assert.deepEqual(scan([{ file: '/tmp/package/skills/realtimeavatar-api.md', text: phrase }]), [], 'an extracted tarball skills/ path counts too')
  }
  assert.deepEqual(rules(scan(strictFile('a staging pipeline that is down'))), ['staging-environment'], 'lib/ must not get the allowance')
  assert.deepEqual(rules(scan([{ file: 'README.md', text: 'a staging pipeline that is down' }])), ['staging-environment'])
  assert.deepEqual(rules(scan(skillFile('our staging pipeline'))), ['staging-environment'], 'a different wording is not allowed')
  assert.deepEqual(rules(scan(skillFile('capacity_pool: some-pool'))), ['pool-assignment'], 'the allowance does not cover a real assignment')
  assert.deepEqual(rules(scan(skillFile('a staging pipeline that is down, ' + SELF_CHECK_TOKEN))), ['private-vocabulary'], 'the allowance never blanks the rest of the line')
})

test('findings carry file, 1-based line, rule and a bounded match', () => {
  const findings = scan([{ file: 'lib/a.js', text: 'fine\nfine\nkey tic_live_abcdef1234 here\n' }])
  assert.equal(findings.length, 1)
  assert.equal(findings[0].file, 'lib/a.js')
  assert.equal(findings[0].line, 3)
  assert.equal(findings[0].rule, 'real-api-key')
  assert.equal(findings[0].match, 'tic_live_abcdef1234')
  const long = scan(strictFile('ava_' + 'a1b2c3d4'.repeat(4) + 'x'.repeat(100)))
  assert.ok(long.length > 0)
  for (const f of long) assert.ok(f.match.length <= 60)
  const several = scan(strictFile('id ' + UUID_PLACEHOLDER + ' at https://x.workers.dev with ' + SELF_CHECK_TOKEN))
  assert.deepEqual(rules(several), ['uuid', 'workers-dev-host', 'private-vocabulary'], 'every rule that fires on a line is reported')
})

test('scanDirectory walks recursively, reports repo-relative paths and routes skills/ through the allowance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rta-gate-'))
  try {
    mkdirSync(join(dir, 'skills'))
    mkdirSync(join(dir, 'lib', 'tools'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'a.md'), 'about a staging pipeline that is down\n')
    writeFileSync(join(dir, 'lib', 'tools', 'b.js'), 'ok\nconst id = "' + UUID_PLACEHOLDER + '"\n')
    writeFileSync(join(dir, 'LICENSE'), 'MIT\n')
    const findings = scanDirectory(dir)
    assert.deepEqual(findings, [{ file: 'lib/tools/b.js', line: 2, rule: 'uuid', match: UUID_PLACEHOLDER }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the files npm would publish are clean and contain no sources or tests', () => {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const [manifest] = JSON.parse(stdout)
  assert.equal(manifest.name, 'dsh-realtimeavatar')
  const paths = manifest.files.map((f) => f.path)
  assert.ok(paths.length > 0)
  const forbidden = paths.filter((p) => p.startsWith('src/') || p.startsWith('test/') || p.startsWith('scripts/') || p.startsWith('examples/') || p.startsWith('node_modules/'))
  assert.deepEqual(forbidden, [], 'unexpected files in tarball')
  for (const required of ['package.json', 'LICENSE', 'cordis.patch.yml', 'lib/index.js', 'lib/index.d.ts', 'skills/realtimeavatar-quickstart.md', 'skills/realtimeavatar-integrate.md', 'skills/realtimeavatar-avatars.md', 'skills/realtimeavatar-calls.md', 'skills/realtimeavatar-api.md']) {
    assert.ok(paths.includes(required), 'tarball lacks ' + required)
  }
  const entries = paths.map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }))
  const findings = scan(entries)
  assert.deepEqual(findings, [], 'LEAK GATE findings:\n' + findings.map((f) => '  ' + f.file + ':' + f.line + ' [' + f.rule + '] ' + f.match).join('\n'))
})
