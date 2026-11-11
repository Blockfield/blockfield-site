import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// The workshop map cards decide which versions may return to the game without review; exercise the real page helpers.
const page = readFileSync(new URL('../src/pages/admin.astro', import.meta.url), 'utf8')
// SITE95-U2: section helpers live in typed modules; extract from all sources.
const libs = [
  '../src/lib/admin-shell.ts',
  '../src/lib/admin-settings.ts',
  '../src/lib/admin-workshop.ts',
  '../src/lib/admin-overview.ts',
  '../src/lib/admin-players.ts',
  '../src/lib/admin-stats.ts',
  '../src/lib/admin-journal.ts',
  '../src/lib/admin-health.ts',
  '../src/lib/admin-console.ts',
  '../src/lib/admin-tabs.ts',
]
  .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
  .join('\n')
const script = page.split('<script>')[1].split('</script>')[0] + '\n' + libs
const source = ts.createSourceFile('admin.ts', script, ts.ScriptTarget.Latest, true)
const helpers = source.statements
  .filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ['playedVersions', 'mapPathLabel'].includes(node.name?.text),
  )
  .map((node) => node.getText(source))
  .join('\n')
const { playedVersions, mapPathLabel } = new Function(
  `${ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}
  return { playedVersions, mapPathLabel }`,
)()

const v = (id, ...parents) => ({ versionDigest: id, parent: parents[0] ?? null, parents })

test('only versions reachable from the published head count as played, merges included', () => {
  const map = {
    head: { versionDigest: 'merge' },
    versions: [
      v('merge', 'main2', 'work1'),
      v('work2', 'work1'),
      v('work1', 'main1'),
      v('main2', 'main1'),
      v('main1'),
    ],
  }
  assert.deepEqual([...playedVersions(map)].sort(), ['main1', 'main2', 'merge', 'work1'])
  assert.equal(playedVersions({ head: null, versions: [v('draft')] }).size, 0)
})

test('changed paths read as map areas and markup fields', () => {
  assert.equal(mapPathLabel('world/region/r.0.-1.mca'), 'Блоки: X 0…511, Z -512…-1')
  assert.equal(mapPathLabel('world/entities/r.-2.3.mca'), 'Сущности: X -1024…-513, Z 1536…2047')
  assert.equal(mapPathLabel('map.json#/points/B/x'), 'Разметка: points/B/x')
  assert.equal(mapPathLabel('map.json'), 'Разметка карты')
  assert.equal(mapPathLabel('world/region/c.1.2.mcc'), 'world/region/c.1.2.mcc')
})
