// Skill provider: the five bundled docs skills, their catalog shape, the
// frontmatter parser, and how a missing or malformed file degrades.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK, MAX_DESCRIPTION_CHARS, PROVIDER_NAME, createSkillProvider, defaultSkillsDir, parseFrontmatter } from '../lib/skills.js'
import { DOC_PAGES, SKILL_NAMES, SKILL_PAGES } from '../lib/facts.js'

const EXPECTED_NAMES = ['realtimeavatar-quickstart', 'realtimeavatar-integrate', 'realtimeavatar-avatars', 'realtimeavatar-calls', 'realtimeavatar-api']
const SNAPSHOT_NOTICE = '> Snapshot of the public documentation'
const FOOTER_LINE = 'Realtime Avatar — realtime AI avatar API & SDK'
const MAX_SKILL_BYTES = 45000

const pageBySlug = (slug) => DOC_PAGES.find((p) => p.slug === slug)

test('the facts table names the five skills in catalog order', () => {
  assert.deepEqual(SKILL_NAMES, EXPECTED_NAMES)
  assert.equal(PROVIDER_NAME, 'dsh-realtimeavatar')
  assert.equal(BUNDLED_SKILL_RANK, 600)
  assert.equal(MAX_DESCRIPTION_CHARS, 400)
})

test('the default provider lists exactly the five skills, in order', async () => {
  const provider = createSkillProvider()
  assert.equal(provider.name, 'dsh-realtimeavatar')
  const candidates = await provider.list()
  assert.deepEqual(
    candidates.map((c) => c.name),
    EXPECTED_NAMES,
  )
})

test('every candidate carries the catalog shape dsh expects', async () => {
  const skillsDir = defaultSkillsDir()
  const candidates = await createSkillProvider().list()
  for (const c of candidates) {
    assert.equal(typeof c.description, 'string', c.name + ' description')
    assert.ok(c.description.length > 0, c.name + ' has an empty description')
    assert.ok(c.description.length <= 400, c.name + ' description is ' + c.description.length + ' chars')
    assert.ok(c.description.length <= 220, c.name + ' shipped description is ' + c.description.length + ' chars; the catalog lists every skill on every turn, keep it under 220')
    assert.deepEqual(c.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(c.source, 'bundled')
    assert.equal(c.provider, 'dsh-realtimeavatar')
    assert.equal(c.rank, 600)
    assert.deepEqual(c.resourceBase, { kind: 'directory', path: skillsDir })
    assert.match(c.locator, /^file:\/\//, c.name + ' locator must be a file:// URL')
    assert.equal(fileURLToPath(c.locator), c.path, 'locator and path must agree')
    assert.ok(c.path.endsWith('/' + c.name + '.md'), c.name + ' path ends in <name>.md: ' + c.path)
    assert.equal(typeof c.metadata?.snapshot, 'string', c.name + ' metadata.snapshot')
    assert.match(c.metadata.snapshot, /^\d{4}-\d{2}-\d{2}$/, c.name + ' snapshot is an ISO date')
    assert.ok(!Number.isNaN(Date.parse(c.metadata.snapshot)), c.name + ' snapshot parses as a date')
  }
})

test('get() returns the body without frontmatter, opening on the snapshot notice, with a section per source page', async () => {
  const provider = createSkillProvider()
  for (const candidate of await provider.list()) {
    const def = await provider.get(candidate)
    assert.ok(def !== undefined, candidate.name + ' must load')
    assert.equal(def.name, candidate.name)
    assert.equal(typeof def.content, 'string')
    assert.ok(!def.content.startsWith('---'), candidate.name + ' content still starts with frontmatter')
    assert.ok(def.content.startsWith(SNAPSHOT_NOTICE), candidate.name + ' content must open on the snapshot notice; got: ' + def.content.slice(0, 60))
    const headings = def.content.split('\n').filter((line) => line.startsWith('## '))
    const pages = SKILL_PAGES[candidate.name]
    assert.ok(headings.length >= pages.length, candidate.name + ' has ' + headings.length + ' "## " sections for ' + pages.length + ' pages')
    for (const slug of pages) {
      const title = pageBySlug(slug).title
      assert.ok(headings.includes('## ' + title), candidate.name + ' lacks a "## ' + title + '" section for page ' + slug)
    }
  }
})

test('each shipped skill file is small, footer-free, and declares the pages from SKILL_PAGES as its sources', () => {
  const skillsDir = defaultSkillsDir()
  for (const name of SKILL_NAMES) {
    const file = join(skillsDir, name + '.md')
    const bytes = statSync(file).size
    assert.ok(bytes < MAX_SKILL_BYTES, name + ' is ' + bytes + ' bytes (limit ' + MAX_SKILL_BYTES + ')')
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes(FOOTER_LINE), name + ' still carries the site footer line')
    const { data } = parseFrontmatter(text)
    assert.equal(data.name, name)
    const expectedSources = SKILL_PAGES[name].map((slug) => pageBySlug(slug).path.replace(/^\//, ''))
    assert.deepEqual(data.sources.split(',').map((s) => s.trim()), expectedSources, name + ' sources drift from SKILL_PAGES')
  }
})

test('parseFrontmatter handles CRLF, quoted values, colons in values, and absent or unterminated frontmatter', () => {
  const crlf = parseFrontmatter('---\r\nname: x\r\ndescription: "quoted desc"\r\nsnapshot: 2026-01-02\r\n---\r\n\r\nbody line\r\n')
  assert.deepEqual(crlf.data, { name: 'x', description: 'quoted desc', snapshot: '2026-01-02' })
  assert.equal(crlf.body, 'body line\n')

  const single = parseFrontmatter("---\nname: 'y'\ndescription: a: b: c\n---\nbody\n")
  assert.equal(single.data.name, 'y')
  assert.equal(single.data.description, 'a: b: c')
  assert.equal(single.body, 'body\n')

  const missing = parseFrontmatter('just text\n\n## Heading\n')
  assert.deepEqual(missing.data, {})
  assert.equal(missing.body, 'just text\n\n## Heading\n')

  const unterminated = parseFrontmatter('---\nname: x\nno closing fence\n')
  assert.deepEqual(unterminated.data, {})
  assert.equal(unterminated.body, '---\nname: x\nno closing fence\n')

  const empty = parseFrontmatter('')
  assert.deepEqual(empty.data, {})
  assert.equal(empty.body, '')
})

test('a provider over a directory with missing or malformed files warns once each and skips them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rta-skills-'))
  try {
    const good = (name, description) => '---\nname: ' + name + '\ndescription: ' + description + '\nsnapshot: 2026-01-01\nsources: docs.md\n---\n\nbody of ' + name + '\n'
    writeFileSync(join(dir, 'realtimeavatar-quickstart.md'), good('realtimeavatar-quickstart', 'fine'))
    // realtimeavatar-integrate.md deliberately missing
    writeFileSync(join(dir, 'realtimeavatar-avatars.md'), good('some-other-name', 'name does not match the file'))
    writeFileSync(join(dir, 'realtimeavatar-calls.md'), good('realtimeavatar-calls', 'd'.repeat(500)))
    writeFileSync(join(dir, 'realtimeavatar-api.md'), '---\nname: realtimeavatar-api\n---\n\nno description\n')

    const warnings = []
    const provider = createSkillProvider(dir, (m) => warnings.push(m))

    const first = await provider.list()
    assert.deepEqual(
      first.map((c) => c.name),
      ['realtimeavatar-quickstart', 'realtimeavatar-calls'],
    )
    assert.equal(first.length, SKILL_NAMES.length - 3, 'three files are skipped')
    assert.equal(warnings.length, 3, 'one warning per skipped file: ' + JSON.stringify(warnings))
    assert.ok(warnings.some((w) => /skill file missing/.test(w) && w.includes('realtimeavatar-integrate.md')))
    assert.ok(warnings.some((w) => /bad frontmatter/.test(w) && w.includes('realtimeavatar-avatars.md')))
    assert.ok(warnings.some((w) => /bad frontmatter/.test(w) && w.includes('realtimeavatar-api.md')))
    for (const w of warnings) assert.match(w, /^\[dsh-realtimeavatar\] /)

    // An over-long description is truncated to the catalog cap.
    assert.equal(first.find((c) => c.name === 'realtimeavatar-calls').description.length, 400)
    assert.deepEqual(first[0].resourceBase, { kind: 'directory', path: dir })

    // The list is cached and never re-warns.
    const second = await provider.list()
    assert.equal(second, first)
    assert.equal(warnings.length, 3)

    // get() on a skipped skill returns undefined without a second warning.
    for (const name of ['realtimeavatar-integrate', 'realtimeavatar-avatars', 'realtimeavatar-api']) {
      assert.equal(await provider.get({ name }), undefined, name + ' must not resolve')
    }
    assert.equal(warnings.length, 3, 'get() must not repeat warnings')

    const loaded = await provider.get(first[0])
    assert.equal(loaded.content, 'body of realtimeavatar-quickstart\n')
    assert.equal(loaded.metadata.snapshot, '2026-01-01')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
