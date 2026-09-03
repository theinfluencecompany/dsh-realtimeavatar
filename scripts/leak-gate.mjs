// Leak gate: the published package must contain nothing about private
// infrastructure — only the public realtimeavatar.ai surface. Used by
// test/leak-gate.test.mjs (over the files `npm pack` would ship), by
// scripts/sync-docs.mjs (over generated skill text) and by CI / prepublishOnly
// (over the extracted tarball). Exit 1 on any finding.
//
//   node scripts/leak-gate.mjs            # pack, extract, scan
//   node scripts/leak-gate.mjs <dir>      # scan an extracted package dir
//
// Two kinds of rules. GENERIC patterns are public (ids, keys, hosts, paths,
// environment names). PRIVATE vocabulary is stored only as salted SHA-256
// digests of lower-cased tokens, so this file does not itself publish the
// words it is guarding against; candidates are every separator-delimited
// substring of each token run in a line.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Regex patterns with a self-check sample that must trigger them. */
export const PATTERNS = [
  { name: 'cloudflare-account-or-hex-id', re: /\b[0-9a-f]{32}\b/i, sample: '0123456789abcdef0123456789abcdef', allowRepeatedChar: true },
  { name: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, sample: '12345678-1234-4123-8123-123456789abc', allowZero: true },
  { name: 'real-api-key', re: /tic_(live|test)_[A-Za-z0-9][A-Za-z0-9_-]{5,}/i, sample: 'tic_live_abcdef1234' },
  { name: 'vendor-avatar-id', re: /ava_[0-9a-f]{32}/i, sample: 'ava_0123456789abcdef0123456789abcdef' },
  { name: 'mcp-claim', re: /\bmcps?\b|model context protocol/i, sample: 'an MCP server' },
  { name: 'pool-assignment', re: /capacity_pool\s*[:=]\s*["']?(?!primary["']?\s*$)[A-Za-z0-9_-]+/, sample: 'capacity_pool: some-pool' },
  { name: 'local-path', re: /\/(home|Users)\/[A-Za-z0-9._-]+\//, sample: '/home/someone/x' },
  { name: 'placeholder-email', re: /@test\.local\b/, sample: 'a@test.local' },
  { name: 'workers-dev-host', re: /\.workers\.dev\b/i, sample: 'x.workers.dev' },
  { name: 'canary-environment', re: /\bcanary\b/i, sample: 'the canary worker' },
  { name: 'staging-environment', re: /\bstaging\b/i, sample: 'staging-foo' },
  { name: 'github-packages-registry', re: /npm\.pkg\.github\.com/i, sample: 'npm.pkg.github.com' },
  { name: 'cloudflare-storage-host', re: /cloudflarestorage\.com|registry\.cloudflare\.com/i, sample: 'x.r2.cloudflarestorage.com' },
  { name: 'livekit-cloud-host', re: /livekit\.cloud\b/i, sample: 'x.livekit.cloud' },
]

const SALT = 'dsh-realtimeavatar-leak-gate-v1'
export function digest(token) {
  return createHash('sha256').update(SALT + ':' + token.toLowerCase()).digest('hex')
}

/** Salted digests of private vocabulary (hostnames, product/repo names, env vars, fleet words, internal routes). */
const PRIVATE_DIGESTS = new Set([
  'ceda16c70489d536eadad797efa75855d162246626dc94baf210a63fbaada6a6', 'fe11087625da2dbe1c3a0d0ae0a8780413736a2c4045430eba7faf3afe141e94',
  '1bdf76e279afee9d7d841a20cb7d04fa42f4b85b982771d7cb7cd2785489c3e6', '4c3f4058c5eeacff680b6f72a59ba029e7c0323cc25e42f00dff527ac0572636',
  '50471b9faf08d55a8ef8b13c5cb5b5f3770f07cd46bbe40ff646985cfbf3e646', '2904559d1de030ae438eea1798644a11a9212bb6c51bc8e291b020438d57b505',
  'ef9f3fed6640eab681f9a8b320968f3336a25863faf23cf1d8b55378ca22c053', '639d59ef9e9413278c4f866364adb6c067927a57d99966a754ec0b470a5b05ee',
  '307c76e61a343d05974d141acc98bad14f5bf92dd331c110eb75b0408d9cb3dd', 'bad7d01cab10dfcb540283f10c7a5b314d215d45a1e693927de68c10921c792b',
  'fa6a120565c8681a0e223cef2f2feaf10bcce37452caa7d223679359eadfb46f', '51eea5b64fb68e584dd04e96bb912038b500e0e58e72c0775f382a5dcdf7a12f',
  '6fe1ad7f5884a915ce4fca1bbdb7871d37bc10ec72b871b2cdb2ff536dd214b3',
  '9a26ecebc8639cfb18209ca1f503b26504dcff95a085e83428099f5eba29b947', '80331e46edb716b6864b8eb85ae62f207689405e97b150000c50f7d1f0b40723',
  '96570577f9cc65e5cc5e72ff593942ba36c6f454b96e0da12d76981c73c44048', 'e9cacbb496c2758e3f788817f3fc12ae2fe8ccdefc0b90e0176c8d918b6d4a2c',
  'e6ce0992dfb84d67ae24837ec9e193127bc0cf6addb76c14f3644ba78d3169f3', '5031187642c83f5553801d8e471492ad383d41e6b311ee13329aaa0d83515a22',
  '02fa529a997c4e6721091757bf52c58a61bc6322c1e30670387e3d94a819163f', 'eb9d9034216f68a343711e862965911eab46037271c8a033f30bb8cdf210beb2',
  'c36efdcf01c0f3222f867c3c038a35d88b60b4a2b43608d6e1c3676140965d63', '83c8ffbc942a763c9a1eda33b4fcaaa386de68f367a7180b162a60d88deedd07',
  '831ec69b1516810596e385a816a529fdeaefa4d16483fc93687c58ad7fa408e2', 'e28817fecdf6ec2ff6c27e9e1a22259abab551ce2c38386f9e101370c9b98c09',
  '2e2b50ff389a5183fe302cbc768bb9a34c3b3ca68b5a6e58a64d653dfd4d45df', '011f8fa070eea92eca31effde23b00807a8e68b80f872e88254f05c11e4b64de',
  '4f0b2ae0b67e5496ee18a7408088f4395dd41b854e0c27b711f8edad70d1b7e9', '75b0434c848fcecde116fb397514a539234ed3abd74ff25a6da6124cbb305eeb',
  'b14dd8eec791691ff5988b1f95e7f37476f4e832616be9a64179dc24d160c153', 'b2112a9550f99025fac79bdb47b33d74ad271b33c126c1e67e58956596fccaa7',
  '6782e6a9a4268cb0bde8a519f6b9863c360d514d7860e944d5474f8be4d3e620', '0301fca5a06ace34de059c0ae42ae689683f634b06d439155b5015cac9713d31',
  'b7789bb23dca0539d2f58bd33c6ac96faf3432d3bfc52482bdcd3242c0dec3b2', '3f03af04aa4e2268617207af2ccad323f8b39f4567288f8ae93b159624d593a1',
  '1fe1ab3dc5cbd6ed76f50ebac57d061daf184a536754e4b3a0c38ffcc6b5a6e8', 'e5b4d6b21ac8e3bcd534c4dbcc227a3e897e5c67bd10203c22af0c77cd5b174e',
  '3cf9af5f6a4fb8e9aa89f4bfcb26d4fc2c4c02ff286d175ce1b3551a22f466f6', '8eba336fad507e7fb07ae5244f1952f00b88705ebcdfc97c6dc4add83c740fcf',
  'b5111b28e28f39636aae2e71887f1c2c0c695b3fe33af0755c266fde657feff0',
  // self-check token (not private): "example-private-token"
  '284d21d2b2f6aa4baeb88d1eb87c2d6921520c56ddbfb68cdd9688e4cebf1548',
])

/** Digests that only apply under strict scanning (the word is ordinary UI copy elsewhere). */
const STRICT_ONLY_DIGESTS = new Set(['2e841229c8b710fe70fea69b31f8f3a5e745045ea7ed809d435ddc7141848fee'])

/** Self-check token that must be caught by the digest path. */
export const SELF_CHECK_TOKEN = 'example-private-token'

/**
 * Exact public phrases the docs snapshot may keep verbatim even though a
 * pattern matches inside them. Applies to skills/ only.
 */
export const SKILL_ALLOW_PHRASES = ['a staging pipeline that is down']

/** Candidate substrings of one token run: every contiguous slice of its word/separator parts. */
function candidates(run) {
  const parts = run.split(/([/:.@_-])/).filter((p) => p !== '')
  const out = new Set()
  for (let i = 0; i < parts.length; i += 1) {
    let acc = ''
    for (let j = i; j < parts.length && j - i < 24; j += 1) {
      acc += parts[j]
      if (!/^[/:.@_-]$/.test(parts[j])) out.add(acc)
    }
  }
  return out
}

function digestHits(line, strict) {
  const hits = []
  const lower = line.toLowerCase()
  const runs = lower.match(/[a-z0-9_@./:-]+/g) ?? []
  for (const run of runs) {
    for (const cand of candidates(run)) {
      const d = digest(cand)
      if (PRIVATE_DIGESTS.has(d) || (strict && STRICT_ONLY_DIGESTS.has(d))) hits.push(cand.length > 4 ? cand.slice(0, 2) + '…' + cand.slice(-2) : '…')
    }
  }
  return [...new Set(hits)]
}

function scanText(text, file, { strict }) {
  const findings = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    let probe = line
    if (!strict) for (const phrase of SKILL_ALLOW_PHRASES) probe = probe.split(phrase).join(' ')
    for (const p of PATTERNS) {
      const m = p.re.exec(probe)
      if (m === null) continue
      if (p.allowRepeatedChar && /^(.)\1{31}$/.test(m[0])) continue
      if (p.allowZero && /^[0-]+$/.test(m[0])) continue
      findings.push({ file, line: i + 1, rule: p.name, match: m[0].slice(0, 60) })
    }
    for (const hit of digestHits(probe, strict)) findings.push({ file, line: i + 1, rule: 'private-vocabulary', match: hit })
  })
  return findings
}

/** Scan text or files. Skills get the phrase allowlist; everything else is strict. */
export function scan(entries) {
  const findings = []
  for (const entry of entries) {
    const strict = !/(^|\/)skills\//.test(entry.file)
    findings.push(...scanText(entry.text, entry.file, { strict }))
  }
  return findings
}

/** Every pattern must fire on its own sample and the digest path must catch its self-check token. */
export function selfCheck() {
  const broken = PATTERNS.filter((p) => !p.re.test(p.sample))
  if (broken.length > 0) throw new Error('leak-gate self-check failed for: ' + broken.map((p) => p.name).join(', '))
  if (scan([{ file: 'lib/x.js', text: 'see ' + SELF_CHECK_TOKEN + ' here' }]).length === 0) throw new Error('leak-gate self-check failed: digest path did not fire')
}

function walk(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push({ file: relative(base, full), text: readFileSync(full, 'utf8') })
  }
  return out
}

export function scanDirectory(dir) {
  return scan(walk(dir))
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  selfCheck()
  let dir = process.argv[2]
  let cleanup = null
  if (dir === undefined) {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const tmp = mkdtempSync(join(tmpdir(), 'rta-leak-'))
    execFileSync('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', tmp], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp])
    dir = join(tmp, 'package')
    cleanup = () => rmSync(tmp, { recursive: true, force: true })
  }
  const findings = scanDirectory(dir)
  if (cleanup !== null) cleanup()
  if (findings.length > 0) {
    console.error('LEAK GATE: ' + findings.length + ' finding(s)')
    for (const f of findings) console.error('  ' + f.file + ':' + f.line + ' [' + f.rule + '] ' + f.match)
    process.exit(1)
  }
  console.log('LEAK GATE: clean')
}
