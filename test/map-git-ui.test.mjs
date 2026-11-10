import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { permissions } from '../src/lib/admin.ts'
import { ARENA_MODES } from '../src/lib/game-names.ts'

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
const names = [
  'el',
  'field',
  'mapPathLabel',
  'renderMapChanges',
  'goesLive',
  'compareMap',
  'draftPanel',
  'playedVersions',
  'unpublishedTips',
  'snapshotsPanel',
  'comparePanel',
  'previewCandidate',
  'commitMap',
  'submitSaved',
  'mapRequestError',
  'renderSavedMapSessions',
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
  snapshots: [{ name: 'before-final', versionDigest: SECOND }],
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
  window.mapNotes = new Map()
  window.busyMaps = new Set()
  window.kept = (key, make) => make()
  window.mapLine = () => window.document.createElement('p')
  window.versionLabel = () => '8 октября 2026'
  window.candidateList = []
  window.savedMapSessions = []
  window.reviewOutlets = new Map()
  window.mapSession = { id: COPY, maps: ['fields'] }
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

test('first-version review accepts fast-forward and rejects a moved head', async (t) => {
  const window = dom(t),
    outlet = window.document.createElement('div'),
    line = window.document.createElement('p')
  window.can = (permission) => permissions('admin').includes(permission)
  window.mapCatalog = [{ ...map, head: null }]
  window.compareMap = async () => {
    throw new Error('must not compare without a head')
  }
  window.goesLive = () => ''
  let published
  window.api = async (_path, _method, body) => {
    published = body
    return { id: 'task' }
  }
  window.follow = async () => ({ ok: true })
  window.ask = async () => true
  window.run = (_line, action) => action()
  window.loadMapHistory = async () => {}
  const candidate = { id: 'review', mapId: 'fields', versionDigest: SECOND, targetHead: null }
  await window.previewCandidate(candidate, outlet, line)
  assert.match(outlet.textContent, /Карты ещё нет в игре: эта версия станет первой/)
  assert.match(outlet.textContent, /Принять в игру/)
  const accept = [...outlet.querySelectorAll('button')].find(
    (button) => button.textContent === 'Принять в игру',
  )
  await accept.onclick()
  assert.deepEqual(JSON.parse(JSON.stringify(published)), {
    candidateId: 'review',
    mapId: 'fields',
    expectedHead: null,
  })
  window.mapCatalog = [map]
  await assert.rejects(
    () => window.previewCandidate(candidate, outlet, line),
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

test('the newest unpublished version comes from parent links, not equal timestamps', (t) => {
  // Review r4524308884: two saves can share a timestamp; the tip of the chain is
  // the version no other version builds on.
  const window = dom(t)
  window.can = (permission) => permissions('builder').includes(permission)
  window.mayEditMap = () => true
  window.controller = { revision: 3 }
  const chain = {
    ...map,
    head: null,
    snapshots: [],
    versions: [
      { versionDigest: FIRST, createdAt: 5 },
      { versionDigest: SECOND, createdAt: 5, parent: FIRST },
    ],
  }
  assert.deepEqual(
    window.unpublishedTips(chain).map((version) => version.versionDigest),
    [SECOND],
  )
  window.candidateList = [{ status: 'pending', mapId: 'fields', versionDigest: FIRST }]
  assert.match(window.draftPanel(chain).textContent, /Отправить последнюю версию/)
  window.candidateList = [{ status: 'pending', mapId: 'fields', versionDigest: SECOND }]
  assert.equal(window.draftPanel(chain).textContent.includes('Отправить последнюю версию'), false)
  window.candidateList = []
})

test('a saved but unpublished version can be sent, also before the first publish', (t) => {
  // Review r4524237455: commits never move the head, so a first map has a saved
  // version while head is still null; the send action must be offered then too.
  const window = dom(t)
  window.can = (permission) => permissions('builder').includes(permission)
  window.mayEditMap = () => true
  window.controller = { revision: 3 }
  const first = {
    ...map,
    head: null,
    snapshots: [],
    versions: [{ versionDigest: FIRST, createdAt: 1 }],
  }
  assert.match(window.draftPanel(first).textContent, /Отправить последнюю версию/)
  const published = { ...first, head: { versionDigest: FIRST } }
  assert.equal(
    window.draftPanel(published).textContent.includes('Отправить последнюю версию'),
    false,
  )
})

test('all roles get scoped draft and snapshot actions; only admins resume saved copies', (t) => {
  const window = dom(t)
  for (const role of ['builder', 'moderator', 'admin', 'owner']) {
    window.can = (permission) => permissions(role).includes(permission)
    window.mayEditMap = () => true
    window.controller = { revision: 3 }
    const draft = window.draftPanel(map)
    assert.match(draft.textContent, /Сохранить и отправить на проверку/)
    assert.match(draft.textContent, /Только сохранить версию/)
    assert.match(draft.textContent, /Отправить последнюю версию/)
    assert.match(draft.textContent, /в игру попадает только принятая/)
    assert.equal(draft.textContent.includes('Переименовать карту'), role !== 'builder')
    const snapshots = window.snapshotsPanel(map, false)
    assert.match(snapshots.textContent, /Снимки · 1/)
    assert.match(snapshots.textContent, /before-final/)
    assert.equal(snapshots.textContent.includes('Создать снимок'), true)
    assert.equal(snapshots.textContent.includes('Удалить'), window.can('workshop'))
    const compare = window.comparePanel(map)
    assert.match(compare.textContent, /Сравнение версий/)
    window.candidateList = [{ status: 'pending', mapId: 'fields', versionDigest: SECOND }]
    assert.match(window.draftPanel(map).textContent, /уже на проверке/)
    assert.equal(window.draftPanel(map).textContent.includes('Отправить последнюю версию'), false)
    // r4524282850: an OLDER pending review must not hide sending a newer saved version.
    window.candidateList = [{ status: 'pending', mapId: 'fields', versionDigest: FIRST }]
    assert.match(window.draftPanel(map).textContent, /Отправить последнюю версию/)
    window.candidateList = []
    window.savedMapSessions = [
      {
        id: 'old-copy',
        maps: ['fields'],
        startedAt: 1,
        startedBy: { name: 'Builder' },
      },
    ]
    window.savedSessionsNext = 100
    window.savedSessionsTotal = 101
    window.renderSavedMapSessions()
    assert.equal(
      window.$('#map-drafts').textContent.includes('Продолжить черновик'),
      ['admin', 'owner'].includes(role),
    )
    assert.equal(window.$('#map-drafts-more').hidden, false)
    window.savedMapSessions = []
    // A re-render during a running save must not hand out enabled save/send buttons.
    window.busyMaps.add('fields')
    assert.ok([...window.draftPanel(map).querySelectorAll('form button')].every((b) => b.disabled))
    window.busyMaps.clear()
    window.mayEditMap = () => false
    assert.equal(window.draftPanel(map).querySelectorAll('form').length, 0)
    assert.equal(window.snapshotsPanel(map, false).querySelectorAll('form').length, 0)
  }
})

test('«save and send» commits and reviews in one request; refusal preserves the note', async (t) => {
  const window = dom(t),
    line = window.document.createElement('p'),
    calls = []
  let histories = 0,
    candidates = 0,
    refused = false
  window.mapRequest = async (path, body) => {
    calls.push([path, body])
    if (refused) {
      window.mapRequestError(line, 'no changes since the current map head')
      return null
    }
    return { mapId: body.mapId }
  }
  window.loadMapHistory = async () => {
    histories++
  }
  window.loadCandidates = async () => {
    candidates++
  }
  window.api = async () => {
    throw new Error('a second request is forbidden')
  }
  window.mapNotes.set('fields', 'Новые укрытия')
  await window.commitMap(map, COPY, 'Новые укрытия', line, true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [
      'candidates/create',
      {
        mapId: 'fields',
        workingCopyId: COPY,
        expectedHead: FIRST,
        note: 'Новые укрытия',
        commit: true,
      },
    ],
  ])
  assert.equal(histories, 1)
  assert.equal(candidates, 1)
  assert.equal(window.mapNotes.has('fields'), false)
  refused = true
  window.mapNotes.set('fields', 'Ничего')
  await window.commitMap(map, COPY, 'Ничего', line, true)
  assert.equal(window.mapNotes.get('fields'), 'Ничего')
  assert.equal(histories, 1)
  assert.equal(candidates, 1)
  assert.match(line.textContent, /Нет изменений для сохранения/)
  refused = false
  calls.length = 0
  await window.commitMap(map, COPY, 'Только сохранить', line, false)
  assert.equal(calls[0][0], 'maps/commit')
  assert.equal(calls[0][1].commit, undefined)
  assert.equal(calls[0][1].expectedHead, FIRST)
  assert.equal(candidates, 1)
})

test('saved version goes for review without a new commit', async (t) => {
  const window = dom(t),
    line = window.document.createElement('p'),
    calls = []
  let candidates = 0
  window.mapRequest = async (path, body) => {
    calls.push([path, body])
    return { mapId: body.mapId }
  }
  window.loadCandidates = async () => {
    candidates++
  }
  window.ask = async () => true
  window.run = (_line, action) => action()
  await window.submitSaved(map, COPY, line)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [
      'candidates/create',
      {
        mapId: 'fields',
        workingCopyId: COPY,
        expectedHead: FIRST,
        commit: false,
      },
    ],
  ])
  assert.equal(candidates, 1)
  calls.length = 0
  window.ask = async () => null
  await window.submitSaved(map, COPY, line)
  assert.equal(calls.length, 0)
  assert.equal(candidates, 1)
})

test('a session switch while the dialog is open never redirects the saved-version submit', async (t) => {
  // Review r4524190737: the copy is the one the panel was rendered for, not
  // whatever session is current after the confirmation closes.
  const window = dom(t),
    line = window.document.createElement('p'),
    calls = []
  window.mapRequest = async (path, body) => {
    calls.push([path, body])
    return { mapId: body.mapId }
  }
  window.loadCandidates = async () => {}
  window.ask = async () => {
    window.mapSession = { id: 'another-copy', maps: ['fields'] }
    return true
  }
  window.run = (_line, action) => action()
  await window.submitSaved(map, COPY, line)
  assert.equal(calls[0][1].workingCopyId, COPY)
})

test('review preview compares the frozen target and publishes fast-forward', async (t) => {
  const window = dom(t),
    outlet = window.document.createElement('div'),
    line = window.document.createElement('p')
  window.can = (permission) => permissions('admin').includes(permission)
  window.goesLive = () => ''
  const candidate = { id: 'review', mapId: 'fields', versionDigest: SECOND, targetHead: FIRST }
  const compared = []
  window.mapRequest = async (path, body) => {
    compared.push([path, body])
    return { mapId: 'fields', before: FIRST, after: SECOND, files: [], config: [] }
  }
  let published
  window.api = async (_path, _method, body) => {
    published = body
    return { id: 'task' }
  }
  window.follow = async () => ({ ok: true })
  window.ask = async () => true
  window.run = (_line, action) => action()
  window.loadMapHistory = async () => {}
  await window.previewCandidate(candidate, outlet, line)
  assert.deepEqual(JSON.parse(JSON.stringify(compared)), [
    ['maps/compare', { mapId: 'fields', before: FIRST, after: SECOND }],
  ])
  assert.match(outlet.textContent, /Содержимое версий совпадает/)
  const accept = [...outlet.querySelectorAll('button')].find(
    (button) => button.textContent === 'Принять в игру',
  )
  assert.equal(accept.disabled, false)
  await accept.onclick()
  assert.deepEqual(JSON.parse(JSON.stringify(published)), {
    candidateId: 'review',
    mapId: 'fields',
    expectedHead: FIRST,
  })
  window.mapCatalog = [{ ...map, head: { versionDigest: SECOND } }]
  await assert.rejects(
    () => window.previewCandidate(candidate, outlet, line),
    /Версию в игре сменили/,
  )
})
