import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { parseKitCatalog, validateKitChanges } from '../src/lib/kit-schema.ts'
import { effectiveKits, renderKitForm } from '../src/lib/kit-form.ts'
import { handleAdmin } from '../src/lib/admin.ts'
import { kitFixture } from './kits-fixture.mjs'
import { database } from './storage.mjs'

test('authoritative kit catalog rejects corrupt bounds/registries; structured items refuse raw NBT and wrong typed indices', () => {
  const catalog = parseKitCatalog(kitFixture()),
    kit = structuredClone(catalog.kits[0].effective)
  assert.equal(catalog.modes.length, 7)
  for (const mutate of [
    (value) => (value.fields.count.max = 1000000),
    (value) => value.fields.itemData.push('nbt'),
    (value) => value.items.push(value.items[0]),
    (value) => (value.kits[0].effective.variants[0].items[0].data.gunId = 'unknown:gun'),
  ]) {
    const invalid = kitFixture()
    mutate(invalid)
    assert.throws(() => parseKitCatalog(invalid), /Наборы/)
  }
  for (const mutate of [
    (value) => (value.nbt = '{}'),
    (value) => (value.id = 'wrong'),
    (value) => (value.name = '§unsafe'),
    (value) => value.variants.push(value.variants[0]),
    (value) => (value.variants[0].items[0].count = 0),
    (value) => (value.variants[0].items[0].count = 2),
    (value) => delete value.variants[0].items[0].data,
    (value) => (value.variants[0].items[0].data.ammoId = 'test:round'),
    (value) => (value.variants[0].items[0].data.attachments.SCOPE.id = 'unknown:scope'),
    (value) => (value.curios[0].slot = 'unknown'),
    (value) => (value.drone_settings = { max_active_fpv: 0 }),
  ]) {
    const invalid = structuredClone(kit)
    mutate(invalid)
    assert.throws(() => validateKitChanges({ rifle: invalid }, {}, catalog), /Наборы/)
  }
  const custom = { ...structuredClone(kit), id: 'custom' }
  assert.equal(validateKitChanges({ custom }, { room: 'custom' }, catalog).kits.custom.id, 'custom')
  assert.throws(() => validateKitChanges({}, { room: 'deleted' }, catalog), /должен существовать/)
  assert.doesNotThrow(() =>
    validateKitChanges({ custom: { ...custom, deploymentCost: 1 } }, { room: 'custom' }, catalog),
  )
  assert.throws(
    () => validateKitChanges({ custom }, { training: 'custom' }, catalog),
    /неверный режим/,
  )
  assert.throws(
    () =>
      validateKitChanges(
        { snipers: { ...catalog.kits[1].effective, allowedModeIds: [] } },
        {},
        catalog,
      ),
    /фиксированный набор/,
  )
  assert.doesNotThrow(() => validateKitChanges({}, { snipers: null }, catalog))
  assert.doesNotThrow(() => validateKitChanges({}, { room: 'rifle' }, catalog, { rifle: 0 }))
  assert.doesNotThrow(() => validateKitChanges({}, { room: 'rifle' }, catalog, { rifle: 600 }))
  assert.doesNotThrow(() => validateKitChanges({}, { awp: 'sniper' }, catalog, { sniper: 800 }))
  assert.doesNotThrow(() =>
    validateKitChanges({ rifle: kit }, { room: 'rifle' }, catalog, { rifle: 600 }),
  )
  assert.equal(effectiveKits(catalog, {}, { rifle: 600 }).rifle.deploymentCost, 600)
  assert.equal(effectiveKits(catalog, { rifle: kit }, { rifle: 600 }).rifle.deploymentCost, 0)
})

test('kit changes validate and reset like CP kit saves (see cp-settings-handlers)', () => {
  const catalog = parseKitCatalog(kitFixture()),
    kit = structuredClone(catalog.kits[0].effective)
  const custom = { ...structuredClone(kit), id: 'custom' }
  // CP persistence (stale 409, fixed-mode null, dropped-kit null-delete) rides
  // saveKitSettingsCp: here only the validation contract is pinned.
  assert.equal(validateKitChanges({ custom }, { room: 'custom' }, catalog).kits.custom.id, 'custom')
  assert.throws(() => validateKitChanges({}, { room: 'deleted' }, catalog), /должен существовать/)
  assert.doesNotThrow(() => validateKitChanges({}, { room: null }, catalog))
})

test('kit API is admin/owner-only and reads the catalog from CP presence', async (t) => {
  const catalog = kitFixture()
  const state = new Map()
  const server = http.createServer((req, res) => {
    const answer = (code, data) => {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(data))
    }
    if (req.headers.authorization !== 'Bearer settings-t') return answer(401, { error: 'x' })
    if (req.url.startsWith('/v2/rooms')) {
      let body = ''
      req.on('data', (c) => (body += c))
      return req.on('end', () =>
        answer(200, {
          initialized: true,
          reportedAt: new Date().toISOString(),
          presence: {
            rooms: [],
            kitCatalog: catalog,
            applied: { revision: 0, attemptedRevision: 0, errors: [] },
          },
        }),
      )
    }
    const match = req.url.match(/^\/v2\/settings\/([^/]+)\/([^/?]+)/)
    if (!match) return answer(404, { error: 'not_found' })
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const key = `${match[1]}/${match[2]}`
      const payload = body ? JSON.parse(body) : {}
      if (req.method === 'GET') {
        const current = state.get(key)
        if (!current) return answer(200, { initialized: false, revision: 0, value: {}, hash: 'n' })
        return answer(200, {
          initialized: true,
          revision: current.revision,
          value: current.value,
          hash: 'h',
        })
      }
      const current = state.get(key) ?? { revision: 0, value: {} }
      if (payload.expectedRevision !== current.revision)
        return answer(409, { error: 'revision_conflict' })
      const receipt = { operationId: 'op-1', revision: current.revision + 1 }
      state.set(key, { revision: receipt.revision, value: { ...current.value, ...payload.patch } })
      return answer(202, receipt)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const directory = mkdtempSync(join(tmpdir(), 'bf-kit-api-')),
    environment = { ...process.env },
    store = await database(t)
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  })
  const OWNER = '1'.repeat(32),
    ADMIN = '2'.repeat(32),
    MOD = '3'.repeat(32),
    BUILDER = '4'.repeat(32)
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: OWNER,
    BLOCKFIELD_SETTINGS_DIR: directory,
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_SETTINGS_TOKEN: 'settings-t',
    BLOCKFIELD_CP_CONSUMER_ID: 'game',
  })
  for (const [id, role] of [
    [ADMIN, 'admin'],
    [MOD, 'moderator'],
    [BUILDER, 'builder'],
  ])
    await store.setStaff(id, 'Tester', role, 'seed')
  const call = async (method, actor, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${actor}:Tester`
    const url = new URL('http://site/api/admin/kits'),
      request = new Request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, 'kits', store).catch(
      (error) => error,
    )
  }
  for (const role of [MOD, BUILDER]) {
    assert.equal((await call('GET', role)).status, 403)
    assert.equal(
      (await call('PUT', role, { expectedRevision: 0, kits: {}, fixedModeKits: {} })).status,
      403,
    )
  }
  assert.equal((await (await call('GET', ADMIN)).json()).available, true)
  assert.equal(
    (await call('PUT', ADMIN, { expectedRevision: 0, kits: {}, fixedModeKits: {} })).status,
    200,
  )
})

test('kit forms keep typed catalog controls, lazy item rendering and training visibility without raw JSON', async (t) => {
  const dom = new JSDOM('<form></form>', { url: 'http://site' }),
    previous = { document: globalThis.document, Event: globalThis.Event, Node: globalThis.Node }
  Object.assign(globalThis, {
    document: dom.window.document,
    Event: dom.window.Event,
    Node: dom.window.Node,
  })
  t.after(() => {
    Object.assign(globalThis, previous)
    dom.window.close()
  })
  const catalog = kitFixture(),
    kit = catalog.kits[0].effective
  let draft
  const root = renderKitForm(catalog, kit, (next) => (draft = next))
  document.querySelector('form').append(root)
  assert.equal(root.querySelectorAll('select').length, 0)
  assert.equal(root.querySelectorAll('textarea').length, 0)
  assert.match(root.textContent, /Тренировка/)
  const name = [...root.querySelectorAll('label')].find(
    (label) => label.textContent === 'Название набора',
  )
  const input = document.getElementById(name.htmlFor)
  input.value = 'Изменённый набор'
  input.dispatchEvent(new dom.window.Event('input'))
  assert.equal(draft.name, 'Изменённый набор')
  const parent = [...root.querySelectorAll('details')].find((details) =>
    details.firstElementChild.textContent.startsWith('Предметы варианта'),
  )
  parent.open = true
  const item = parent.querySelector('details')
  item.open = true
  item.dispatchEvent(new dom.window.Event('toggle'))
  assert.match(item.textContent, /Оружие/)
  const select = item.querySelector('select')
  select.value = 'minecraft:stone'
  select.dispatchEvent(new dom.window.Event('change'))
  assert.equal(draft.variants[0].items[0].id, 'minecraft:stone')
  assert.equal(draft.variants[0].items[0].data, undefined)
  assert.deepEqual(effectiveKits(catalog, {}).rifle.name, 'Винтовка')
  assert.equal(effectiveKits(catalog, { custom: { ...kit, id: 'custom' } }).custom.id, 'custom')
})

test('SBW guns keep loaded ammo and reject stacked guns, unsupported metadata and invalid ammo', () => {
  const catalog = parseKitCatalog(kitFixture()),
    kit = structuredClone(catalog.kits[0].effective),
    item = { id: 'superbwarfare:rpg', count: 1, data: { gunAmmo: 1 } }
  kit.variants[0].items = [item]
  for (const ammo of [0, 1, 1000]) {
    item.data = { gunAmmo: ammo }
    assert.doesNotThrow(() => validateKitChanges({ rifle: kit }, {}, catalog))
  }
  for (const invalid of [
    { ...item, count: 2 },
    ...[-1, 0.5, 1001].map((gunAmmo) => ({ ...item, data: { gunAmmo } })),
    ...['gunId', 'fireMode', 'bulletInBarrel', 'attachments', 'armorPlate', 'nbt'].map((field) => ({
      ...item,
      data: { gunAmmo: 1, [field]: field === 'gunId' ? 'test:rifle' : 1 },
    })),
  ]) {
    kit.variants[0].items = [invalid]
    assert.throws(() => validateKitChanges({ rifle: kit }, {}, catalog), /Наборы/)
  }
  kit.variants[0].items = [{ id: 'superbwarfare:rpg', count: 1 }]
  assert.doesNotThrow(() => validateKitChanges({ rifle: kit }, {}, catalog))
  kit.variants[0].items = [{ id: 'minecraft:stone', count: 1, data: { gunAmmo: 1 } }]
  assert.throws(() => validateKitChanges({ rifle: kit }, {}, catalog), /Наборы/)
})

test('SBW ammo editor preserves its loaded value and only exposes supported gun metadata', async (t) => {
  const dom = new JSDOM('<form></form>', { url: 'http://site' }),
    previous = { document: globalThis.document, Event: globalThis.Event, Node: globalThis.Node }
  Object.assign(globalThis, {
    document: dom.window.document,
    Event: dom.window.Event,
    Node: dom.window.Node,
  })
  t.after(() => {
    Object.assign(globalThis, previous)
    dom.window.close()
  })
  const catalog = kitFixture(),
    kit = structuredClone(catalog.kits[0].effective)
  kit.variants[0].items = [{ id: 'superbwarfare:rpg', count: 1, data: { gunAmmo: 1 } }]
  let draft
  const root = renderKitForm(catalog, kit, (next) => (draft = next))
  document.querySelector('form').append(root)
  const parent = [...root.querySelectorAll('details')].find((details) =>
    details.firstElementChild.textContent.startsWith('Предметы варианта'),
  )
  parent.open = true
  const item = parent.querySelector('details')
  item.open = true
  item.dispatchEvent(new dom.window.Event('toggle'))
  const labels = [...item.querySelectorAll('label')]
  assert.deepEqual(
    labels.map((label) => label.firstChild.textContent),
    ['Предмет', 'Количество', 'Боеприпасов в оружии'],
  )
  const count = document.getElementById(labels[1].htmlFor),
    ammo = document.getElementById(labels[2].htmlFor)
  assert.equal(count.value, '1')
  assert.equal(count.readOnly, true)
  assert.equal(count.max, '1')
  assert.equal(ammo.value, '1')
  assert.equal(ammo.min, '0')
  assert.equal(ammo.max, '1000')
  assert.equal(ammo.step, '1')
  ammo.value = '0'
  ammo.dispatchEvent(new dom.window.Event('input'))
  assert.deepEqual(draft.variants[0].items[0].data, { gunAmmo: 0 })
  ammo.value = ''
  ammo.dispatchEvent(new dom.window.Event('input'))
  assert.equal(draft.variants[0].items[0].data, undefined)
  const select = item.querySelector('select')
  select.value = 'minecraft:stone'
  select.dispatchEvent(new dom.window.Event('change'))
  assert.equal(draft.variants[0].items[0].data, undefined)
})

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
const source = ts.createSourceFile(
  'admin.ts',
  page.split('<script>')[1].split('</script>')[0] + '\n' + libs,
  ts.ScriptTarget.Latest,
  true,
)
const autosave = ts.transpileModule(
  source.statements
    .filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        [
          'commitKits',
          'loadKits',
          'kitDiff',
          'kitDraftDiff',
          'kitPatch',
          'kitValue',
          'rememberKitChange',
        ].includes(node.name?.text),
    )
    .map((node) => node.getText(source))
    .join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText

function kitAutosave(t) {
  const dom = new JSDOM(
    '<form id="kits-form"><div class="field"><input><span class="state"></span></div></form><p id="kits-status"></p>',
    { runScripts: 'outside-only' },
  )
  t.after(() => dom.window.close())
  const window = dom.window
  window.structuredClone = structuredClone
  window.effectiveKits = effectiveKits
  window.validateKitChanges = validateKitChanges
  window.initialCatalog = parseKitCatalog(kitFixture())
  window.eval(`
    const $ = s => document.querySelector(s);
    const kitChanges = new Map(), kitTimers = new Map(); let kitEditingControl = null, observedSettingsRevision = 0;
    let kitClassCosts = {}, kitCatalog = initialCatalog, kitQueue = Promise.resolve(), kitPending = 0, kitTimer, kitRevision = 3;
    let kitOverrides = {}, kitBindings = {}, kitSnapshot = JSON.stringify({kits:{},fixedModeKits:{}}), kitDraftSnapshot = kitSnapshot;
    const kitBody = () => JSON.stringify({kits:kitOverrides,fixedModeKits:kitBindings});
    const fieldState = (line, text) => line.textContent = text;
    const say = fieldState, autosaveError = error => error.message;
    const loadSettings = async () => {}, kitMeta = () => {}, renderKits = () => {};
    const toast = text => window.notice = text;
    const changeToast = (_label,_old,_new,_secret,undo) => window.undo = undo;
    ${autosave}
    window.draft = (kits, bindings = {}) => { kitOverrides = kits; kitBindings = bindings; };
    window.flush = () => kitQueue;
    window.snapshot = () => kitSnapshot;
    window.observe = revision => observedSettingsRevision = revision;
    window.baseline = kits => { kitOverrides = structuredClone(kits); kitSnapshot = kitDraftSnapshot = kitBody(); };
    window.edit = (control, before, after, path) => { kitEditingControl = control; rememberKitChange(before, after, path); kitPatch({kits:kitOverrides,fixedModeKits:kitBindings}, {path,value:after}); };
    window.state = () => ({ revision:kitRevision, kits:kitOverrides });
    window.dropCatalog = () => { kitCatalog = undefined; kitSnapshot = kitDraftSnapshot = ''; kitOverrides = {}; };
  `)
  return window
}

test('kit autosave retries stale revisions without overwriting other kits; undo refuses a newer edit', async (t) => {
  const window = kitAutosave(t),
    kit = structuredClone(kitFixture().kits[0].effective)
  window.draft({ rifle: { ...kit, name: 'Новый набор' } })
  let settings = { revision: 3, kits: {} },
    writes = 0
  window.api = async (_path, method, body) => {
    if (!method) return { settings: structuredClone(settings) }
    writes++
    if (writes === 1) {
      settings = { revision: 4, kits: { remote: { ...kit, id: 'remote' } } }
      throw Object.assign(new Error('stale'), { status: 409 })
    }
    assert.equal(body.expectedRevision, 4)
    assert.equal(body.kits.remote.id, 'remote')
    settings = structuredClone({ revision: 5, ...body })
    return { settings }
  }
  await window.commitKits()
  assert.equal(writes, 2)
  assert.equal(settings.kits.rifle.name, 'Новый набор')
  assert.match(window.document.querySelector('#kits-status').textContent, /Сохранено/)
  settings.kits.rifle.name = 'Чужая правка'
  window.undo()
  await window.flush()
  assert.equal(writes, 2)
  assert.match(window.notice, /Отмена недоступна/)
})

test('kit autosave keeps invalid drafts and blocks live catalog replacement while editing', async (t) => {
  const window = kitAutosave(t),
    kit = structuredClone(kitFixture().kits[0].effective)
  window.draft({ rifle: { ...kit, name: '' } })
  let writes = 0
  window.api = async (_path, method) => {
    if (method) writes++
    return { settings: { revision: 3, kits: {} } }
  }
  await window.commitKits()
  assert.equal(writes, 0)
  assert.match(window.document.querySelector('#kits-status').textContent, /Наборы/)
  window.api = () => {
    throw Error('Focused draft must stay')
  }
  window.document.querySelector('input').focus()
  await window.loadKits(true)
  assert.equal(JSON.parse(window.snapshot()).kits.rifle, undefined)
  window.draft({ rifle: kit })
  const control = window.document.querySelector('input')
  control.required = true
  control.value = ''
  window.api = () => {
    throw Error('Invalid native control must not save')
  }
  window.edit(control, kit.name, 'Edited', ['kits', 'rifle', 'name'])
  await window.commitKits(undefined, control)
  assert.equal(window.document.querySelector('.state').textContent, 'Исправьте значение.')
  control.required = false
  window.dropCatalog()
  window.api = async (path) =>
    path === 'kits'
      ? { available: true, catalog: window.initialCatalog }
      : { settings: { revision: 4, kits: {} } }
  await window.loadKits(true)
  assert.match(window.document.querySelector('#kits-status').textContent, /3 наборов в каталоге/)
})

test('one kit control preserves a concurrent price and an unrelated invalid name draft', async (t) => {
  const window = kitAutosave(t),
    kit = structuredClone(kitFixture().kits[0].effective),
    name = window.document.querySelector('input'),
    price = name.cloneNode()
  name.after(price)
  window.baseline({ rifle: kit })
  window.edit(name, kit.name, '', ['kits', 'rifle', 'name'])
  name.required = true
  name.value = ''
  window.edit(price, kit.deploymentCost, 50, ['kits', 'rifle', 'deploymentCost'])
  let settings = { revision: 4, kits: { rifle: { ...kit, name: 'Чужое название' } } }
  window.api = async (_path, method, body) => {
    if (!method) return { settings: structuredClone(settings) }
    assert.equal(body.kits.rifle.name, 'Чужое название')
    assert.equal(body.kits.rifle.deploymentCost, 50)
    settings = { revision: 5, kits: structuredClone(body.kits) }
    return { settings }
  }
  await window.commitKits(undefined, price)
  assert.equal(window.state().kits.rifle.name, '')
  assert.equal(window.state().kits.rifle.deploymentCost, 50)
  assert.equal(settings.kits.rifle.name, 'Чужое название')
  window.edit(name, '', 'Моё название', ['kits', 'rifle', 'name'])
  name.value = 'Моё название'
  settings.kits.rifle.deploymentCost = 75
  window.api = async (_path, method, body) => {
    if (!method) return { settings: structuredClone(settings) }
    assert.equal(body.kits.rifle.deploymentCost, 75)
    assert.equal(body.kits.rifle.name, 'Моё название')
    return { settings: { revision: 6, kits: body.kits } }
  }
  await window.commitKits(undefined, name)
  assert.equal(window.state().kits.rifle.deploymentCost, 75)
})

test('stale kit catalog and save replies acknowledge without replacing newer baselines', async (t) => {
  const window = kitAutosave(t),
    kit = structuredClone(kitFixture().kits[0].effective),
    control = window.document.querySelector('input')
  window.baseline({ rifle: kit })
  const snapshot = window.snapshot()
  window.observe(8)
  window.api = async (path) =>
    path === 'kits'
      ? { available: true, catalog: window.initialCatalog }
      : { settings: { revision: 7, kits: { rifle: { ...kit, name: 'Старый' } } } }
  await window.loadKits()
  assert.equal(window.snapshot(), snapshot)
  window.edit(control, kit.name, 'Моё название', ['kits', 'rifle', 'name'])
  let writes = 0
  window.api = async (_path, method) => {
    if (!method) return { settings: { revision: 8, kits: { rifle: kit } } }
    writes++
    window.observe(10)
    return { settings: { revision: 9, kits: { rifle: { ...kit, name: 'Моё название' } } } }
  }
  await window.commitKits(undefined, control)
  assert.equal(writes, 1)
  assert.equal(window.snapshot(), snapshot)
  assert.equal(window.state().revision, 3)
  assert.match(window.document.querySelector('#kits-status').textContent, /Сохранено/)
})

test('live kit refresh rechecks drafts and focus after its requests finish', async (t) => {
  const window = kitAutosave(t),
    kit = structuredClone(kitFixture().kits[0].effective)
  window.baseline({ rifle: kit })
  let finish
  window.api = async (path) =>
    path === 'kits'
      ? { available: true, catalog: window.initialCatalog }
      : new Promise((resolve) => {
          finish = resolve
        })
  const refreshing = window.loadKits(true)
  const control = window.document.querySelector('input')
  control.focus()
  window.edit(control, kit.name, 'Черновик', ['kits', 'rifle', 'name'])
  finish({ settings: { revision: 4, kits: { rifle: kit } } })
  await refreshing
  assert.equal(window.state().kits.rifle.name, 'Черновик')
  assert.equal(window.state().revision, 3)
})

test('kit reset removes its override without recreating a partial kit; undo restores only its field', async (t) => {
  const window = kitAutosave(t),
    kit = structuredClone(kitFixture().kits[0].effective),
    control = window.document.querySelector('input')
  window.baseline({ rifle: { ...kit, name: 'Изменённый' } })
  window.edit(control, { ...kit, name: 'Изменённый' }, undefined, ['kits', 'rifle'])
  let settings = { revision: 3, kits: { rifle: { ...kit, name: 'Изменённый' } } }
  window.api = async (_path, method, body) => {
    if (!method) return { settings: structuredClone(settings) }
    settings = { revision: settings.revision + 1, kits: structuredClone(body.kits) }
    return { settings }
  }
  await window.commitKits(undefined, control)
  assert.equal(window.state().kits.rifle, undefined)
  assert.equal(settings.kits.rifle, undefined)
  window.baseline({ rifle: kit })
  settings.kits = { rifle: structuredClone(kit) }
  window.edit(control, kit.name, 'Название', ['kits', 'rifle', 'name'])
  await window.commitKits(undefined, control)
  settings.kits.rifle.deploymentCost = 85
  window.undo()
  await window.flush()
  assert.equal(settings.kits.rifle.name, kit.name)
  assert.equal(settings.kits.rifle.deploymentCost, 85)
  assert.equal(window.state().kits.rifle.name, kit.name)
})
