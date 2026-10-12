import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { permissions } from '../src/lib/admin.ts'
import { ARENA_MODES } from '../src/lib/game-names.ts'

const page = readFileSync(new URL('../src/pages/admin.astro', import.meta.url), 'utf8')
const script = page.split('<script>')[1].split('</script>')[0]
const source = ts.createSourceFile('admin.ts', script, ts.ScriptTarget.Latest, true)
const names = [
  'el',
  'field',
  'mapPathLabel',
  'renderMapChanges',
  'branchLabel',
  'draftPanel',
  'branchesPanel',
  'requestReview',
  'commitMap',
  'renderSavedMapSessions',
  'previewMapReview',
  'newMapControls',
  'testMapCandidate',
  'mapAvailabilityControls',
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
  mapJson: { id: 'fields', name: 'Поля' },
  head: { versionDigest: FIRST },
  branches: [
    { name: 'main', versionDigest: FIRST },
    { name: 'layout', versionDigest: SECOND },
    { name: 'redo', versionDigest: FIRST },
  ],
  versions: [FIRST, SECOND].map((versionDigest) => ({ versionDigest, createdAt: 1 })),
}
function dom(t) {
  const dom = new JSDOM(
    '<div id="map-drafts"></div><button id="map-drafts-more"></button><p id="map-drafts-status"></p><p id="map-create-status"></p>',
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
  window.busyMaps = new Set()
  window.kept = (key, make) => make()
  window.mapLine = () => window.document.createElement('p')
  window.versionLabel = () => '8 октября 2026'
  window.candidateList = []
  window.savedMapSessions = []
  window.mapSession = { id: COPY, branches: { fields: 'layout' } }
  window.mapCatalog = [map]
  window.ARENA_MODES = ARENA_MODES
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
  assert.throws(() => window.renderMapChanges(outlet, {}), /Не удалось сравнить версии/)
})

test('zero-map form requires a mode and keeps failed drafts; successful creation uses current CAS without a browser session UUID', async (t) => {
  const window = dom(t),
    form = window.newMapControls()
  window.document.body.append(form)
  window.can = (permission) => permissions('moderator').includes(permission)
  window.controller = { phase: 'workshop', gate: 'builders', revision: 9 }
  let pending,
    request,
    loads = 0
  window.run = (_line, action) => (pending = action())
  window.ask = async () => new window.FormData()
  window.loadMapHistory = async () => {
    loads++
  }
  window.mapRequest = async (path, body) => {
    request = { path, body }
    return null
  }
  form.elements.namedItem('mapId').value = 'empty_map'
  form.elements.namedItem('name').value = 'Пустая карта'
  form.onsubmit({ preventDefault() {} })
  assert.match(window.$('#map-create-status').textContent, /хотя бы один режим/)
  assert.equal(request, undefined)
  assert.equal(form.querySelectorAll('[name="supportedModes"]').length, 7)
  form.querySelector('[value="training"]').checked = true
  form.onsubmit({ preventDefault() {} })
  await pending
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    path: 'maps/create',
    body: {
      mapId: 'empty_map',
      name: 'Пустая карта',
      supportedModes: ['training'],
      expectedRevision: 9,
    },
  })
  assert.equal(form.elements.namedItem('name').value, 'Пустая карта')
  window.mapRequest = async () => ({ mapId: 'empty_map' })
  form.onsubmit({ preventDefault() {} })
  await pending
  assert.equal(form.elements.namedItem('name').value, '')
  assert.equal(loads, 1)
})

test('private first review previews an empty base and rejects stale publication absence', async (t) => {
  const window = dom(t),
    outlet = window.document.createElement('div'),
    line = window.document.createElement('p')
  window.can = (permission) => permissions('admin').includes(permission)
  window.mapCatalog = [{ ...map, head: null }]
  let requested
  window.mapRequest = async (_path, body) => {
    requested = body
    return {
      sourceVersion: SECOND,
      targetVersion: null,
      baseVersion: null,
      conflicts: [],
      unresolved: [],
      changes: {
        files: [],
        config: [{ path: '/name', beforePresent: false, afterPresent: true, after: 'Поля' }],
      },
    }
  }
  const candidate = { id: 'review', mapId: 'fields', versionDigest: SECOND, targetHead: null }
  await window.previewMapReview(candidate, outlet, line)
  assert.equal(requested.expectedHead, null)
  assert.match(outlet.textContent, /Карты ещё нет в игре: эта версия станет первой/)
  assert.match(outlet.textContent, /Отсутствует/)
  window.mapCatalog = [map]
  await assert.rejects(
    () => window.previewMapReview(candidate, outlet, line),
    /Версию в игре сменили/,
  )
})

test('test modal sends selected frozen supported mode and never invents modes', async (t) => {
  const window = dom(t),
    line = window.document.createElement('p')
  window.controller = { revision: 12 }
  let request
  window.ask = async ({ fields }) => {
    const form = window.document.createElement('form')
    form.append(...fields)
    form.querySelector('select').value = 'training'
    return new window.FormData(form)
  }
  window.run = (_line, action) => action()
  window.api = async (path, method, body) => {
    request = { path, method, body }
    return { id: 'task' }
  }
  window.follow = async () => ({ ok: true })
  window.loadOverview = async () => {}
  await window.testMapCandidate(
    { id: 'review', mapId: 'fields', supportedModes: ['tdm', 'training'] },
    line,
  )
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    path: 'mode',
    method: 'POST',
    body: { profile: 'test', expectedRevision: 12, candidateId: 'review', modeId: 'training' },
  })
  await assert.rejects(
    () => window.testMapCandidate({ id: 'old', mapId: 'fields' }, line),
    /не подтверждены/,
  )
})

test('availability displays observed state, marks pending changes and reserves operational controls for administrators', (t) => {
  const window = dom(t),
    line = window.document.createElement('p')
  window.mapAvailability = {
    available: true,
    revision: 7,
    disabledMapIds: ['fields'],
    applied: null,
  }
  for (const role of ['builder', 'moderator', 'admin', 'owner']) {
    window.can = (permission) => permissions(role).includes(permission)
    const controls = window.mapAvailabilityControls(map, line)
    assert.match(controls.textContent, /пока не получено/)
    assert.equal(
      controls.querySelectorAll('button').length,
      ['admin', 'owner'].includes(role) ? 1 : 0,
    )
  }
  window.mapAvailability.applied = { revision: 7, disabledMapIds: ['fields'] }
  assert.match(window.mapAvailabilityControls(map, line).textContent, /Отключена для новых матчей/)
  window.mapAvailability.applied.disabledMapIds = []
  assert.match(
    window.mapAvailabilityControls(map, line).textContent,
    /Ожидает применения: отключение/,
  )
  assert.equal(window.mapAvailabilityControls({ ...map, head: null }, line).textContent, '')
})

test('all roles get scoped draft and branch actions; only moderator and reviewers activate saved copies', (t) => {
  const window = dom(t),
    branch = map.branches[1]
  for (const role of ['builder', 'moderator', 'admin', 'owner']) {
    window.can = (permission) => permissions(role).includes(permission)
    window.mayEditMap = () => true
    window.controller = { revision: 3 }
    const draft = window.draftPanel(map, branch)
    assert.match(draft.textContent, /Сохранить и отправить на проверку/)
    assert.match(draft.textContent, /Только сохранить версию/)
    assert.match(draft.textContent, /ещё не отправлена на проверку/)
    assert.equal(draft.textContent.includes('Переименовать карту'), role !== 'builder')
    const branches = window.branchesPanel(map, false)
    // The open branch has no «open» action; another one does, for session-switching roles only.
    assert.equal(branches.textContent.includes('Открыть в мастерской'), role !== 'builder')
    assert.match(branches.textContent, /Открыта в мастерской/)
    window.candidateList = [{ status: 'pending', mapId: 'fields', versionDigest: SECOND }]
    assert.match(window.draftPanel(map, branch).textContent, /уже на проверке/)
    assert.equal(
      window.draftPanel(map, branch).textContent.includes('Отправить последнюю версию'),
      false,
    )
    window.candidateList = []
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
    window.savedMapSessions = []
    // A re-render during a running save must not hand out enabled save/send buttons.
    window.busyMaps.add('fields')
    assert.ok(
      [...window.draftPanel(map, branch).querySelectorAll('form button')].every((b) => b.disabled),
    )
    window.busyMaps.clear()
    window.mayEditMap = () => false
    assert.equal(window.draftPanel(map, branch).querySelectorAll('form').length, 0)
    assert.equal(window.branchesPanel(map, false).querySelectorAll('form').length, 0)
  }
})

test('«save and send» commits the exact copy, then reviews the re-read branch head', async (t) => {
  const window = dom(t),
    line = window.document.createElement('p'),
    THIRD = 'c'.repeat(64),
    calls = []
  window.mapRequest = async (path, body) => {
    calls.push([path, body])
    return { mapId: body.mapId }
  }
  window.loadMapHistory = async () => {
    window.mapCatalog = [
      { ...map, branches: [map.branches[0], { name: 'layout', versionDigest: THIRD }] },
    ]
  }
  window.api = async (path, method, body) => {
    calls.push([path, body])
    return { id: 'review-task' }
  }
  window.follow = async () => ({ ok: true })
  window.loadCandidates = async () => {}
  window.mapRequestError = () => true
  await window.commitMap(map, map.branches[1], 'Новые укрытия', line, true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [
      'maps/commit',
      {
        mapId: 'fields',
        branch: 'layout',
        workingCopyId: COPY,
        expectedBranchHead: SECOND,
        note: 'Новые укрытия',
      },
    ],
    ['candidates/create', { mapId: 'fields', branch: 'layout', expectedBranchHead: THIRD }],
  ])
  // A branch that ends up equal to the game has nothing to review.
  calls.length = 0
  window.loadMapHistory = async () => {
    window.mapCatalog = [
      { ...map, branches: [map.branches[0], { name: 'layout', versionDigest: FIRST }] },
    ]
  }
  await window.commitMap(map, map.branches[1], 'Ничего', line, true)
  assert.deepEqual(
    calls.map(([path]) => path),
    ['maps/commit'],
  )
  assert.match(line.textContent, /отправлять нечего/)
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
    [...outlet.querySelectorAll('button')].find((button) => button.textContent === 'Принять в игру')
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
      (button) => button.textContent === 'Принять в игру',
    ),
    select = outlet.querySelector('select')
  assert.equal(merge.disabled, false)
  assert.equal(select.value, 'ours')
  select.value = 'theirs'
  select.dispatchEvent(new window.Event('change'))
  assert.equal(merge.disabled, true)
  window.mapCatalog = [{ ...map, head: { versionDigest: SECOND } }]
  await assert.rejects(
    () => window.previewMapReview(candidate, outlet, line),
    /Версию в игре сменили/,
  )
})
