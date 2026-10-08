import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { permissions } from '../src/lib/admin.ts'

const page = readFileSync(new URL('../src/pages/admin.astro', import.meta.url), 'utf8')
const script = page.split('<script>')[1].split('</script>')[0]
const source = ts.createSourceFile('admin.ts', script, ts.ScriptTarget.Latest, true)
const names = [
  'el',
  'field',
  'renderMapChanges',
  'mapGitControls',
  'renderSavedMapSessions',
  'previewMapReview',
]
const helpers = source.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
  .map((node) => node.getText(source))
  .join('\n')
const code = ts.transpileModule(helpers, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText
const FIRST = 'a'.repeat(64),
  SECOND = 'b'.repeat(64),
  COPY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const map = {
  mapId: 'fields',
  kind: 'arena',
  head: { versionDigest: FIRST },
  branches: [
    { name: 'main', versionDigest: FIRST },
    { name: 'layout', versionDigest: SECOND },
  ],
  versions: [FIRST, SECOND].map((versionDigest) => ({ versionDigest, createdAt: 1 })),
}
function dom(t) {
  const dom = new JSDOM(
    '<div id="map-drafts"></div><button id="map-drafts-more"></button><p id="map-drafts-status"></p>',
    { runScripts: 'outside-only' },
  )
  t.after(() => dom.window.close())
  const window = dom.window
  window.$ = (selector) => window.document.querySelector(selector)
  window.fieldId = 0
  window.mapName = (id) => id
  window.date = () => '8 октября 2026'
  window.button = (label, action, className) =>
    window.el('button', { textContent: label, onclick: action, className })
  window.say = (line, text) => {
    line.textContent = text
  }
  window.customSelect = () => {}
  window.openMapBranch = () => {}
  window.submitMap = () => {}
  window.mapNotes = new Map()
  window.mapSession = { id: COPY, branches: { fields: 'layout' } }
  window.mapCatalog = [map]
  window.eval(code)
  return window
}

test('comparison shows exact field values, region bounds and all bounded pages without inventing empty data', (t) => {
  const window = dom(t),
    outlet = window.document.createElement('div')
  const files = Array.from({ length: 105 }, (_, index) => ({
    path: `world/region/r.${index}.0.mca`,
    change: 'modified',
    before: FIRST,
    after: SECOND,
    area: { minX: index * 512, minZ: 0, maxX: index * 512 + 511, maxZ: 511 },
  }))
  window.renderMapChanges(outlet, {
    files,
    config: [
      { path: '/enabled', beforePresent: true, afterPresent: true, before: false, after: null },
    ],
  })
  assert.equal(outlet.querySelectorAll('li').length, 100)
  assert.match(outlet.textContent, /Область: X 0…511/)
  outlet.querySelector('button').click()
  assert.equal(outlet.querySelectorAll('li').length, 106)
  assert.match(outlet.textContent, /ДоfalseПослеnull/)
  assert.equal(outlet.querySelector('button').hidden, true)
  assert.throws(() => window.renderMapChanges(outlet, {}), /корректное сравнение/)
})

test('all roles get scoped work-branch actions; only moderator and reviewers activate saved copies', (t) => {
  const window = dom(t),
    line = window.document.createElement('p')
  for (const role of ['builder', 'moderator', 'admin', 'owner']) {
    window.can = (permission) => permissions(role).includes(permission)
    window.mayEditMap = () => true
    const controls = window.mapGitControls(map, line)
    assert.match(controls.textContent, /Зафиксировать изменения/)
    assert.match(controls.textContent, /Отправить коммит на проверку/)
    assert.match(controls.textContent, /Незакоммиченные изменения/)
    assert.equal(controls.textContent.includes('Открыть ветку'), role !== 'builder')
    window.savedMapSessions = [
      {
        id: 'old-copy',
        maps: ['fields'],
        branches: { fields: 'layout' },
        startedAt: 1,
        startedBy: { name: 'Builder' },
      },
    ]
    window.savedSessionsNext = 100
    window.savedSessionsTotal = 101
    window.renderSavedMapSessions()
    assert.equal(
      window.$('#map-drafts').textContent.includes('Продолжить черновик'),
      role !== 'builder',
    )
    assert.equal(window.$('#map-drafts-more').hidden, false)
    window.mayEditMap = () => false
    assert.equal(window.mapGitControls(map, line).querySelectorAll('form').length, 0)
  }
})

test('merge stays disabled until exact conflict choices have been recomputed; a changed choice invalidates approval', async (t) => {
  const window = dom(t),
    outlet = window.document.createElement('div'),
    line = window.document.createElement('p')
  window.can = (permission) => permissions('admin').includes(permission)
  const candidate = { id: 'review', mapId: 'fields', versionDigest: SECOND, targetHead: FIRST }
  window.mapRequest = async () => ({
    sourceVersion: SECOND,
    targetVersion: FIRST,
    changes: { files: [], config: [] },
    conflicts: [
      {
        path: 'world/region/r.0.0.mca',
        kind: 'binary',
        oursPresent: true,
        theirsPresent: true,
        ours: FIRST,
        theirs: SECOND,
      },
    ],
    unresolved: ['world/region/r.0.0.mca'],
  })
  await window.previewMapReview(candidate, outlet, line)
  assert.equal(
    [...outlet.querySelectorAll('button')].find((button) => button.textContent === 'Слить в main')
      .disabled,
    true,
  )
  window.mapRequest = async () => ({
    sourceVersion: SECOND,
    targetVersion: FIRST,
    changes: { files: [], config: [] },
    conflicts: [
      {
        path: 'world/region/r.0.0.mca',
        kind: 'binary',
        oursPresent: true,
        theirsPresent: true,
        ours: FIRST,
        theirs: SECOND,
      },
    ],
    unresolved: [],
  })
  await window.previewMapReview(candidate, outlet, line, { 'world/region/r.0.0.mca': 'ours' })
  const merge = [...outlet.querySelectorAll('button')].find(
      (button) => button.textContent === 'Слить в main',
    ),
    select = outlet.querySelector('select')
  assert.equal(merge.disabled, false)
  assert.equal(select.value, 'ours')
  select.value = 'theirs'
  select.dispatchEvent(new window.Event('change'))
  assert.equal(merge.disabled, true)
  window.mapCatalog = [{ ...map, head: { versionDigest: SECOND } }]
  await assert.rejects(() => window.previewMapReview(candidate, outlet, line), /Main изменилась/)
})
