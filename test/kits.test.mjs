import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { parseKitCatalog, validateKitChanges } from '../src/lib/kit-schema.ts'
import { effectiveKits, renderKitForm } from '../src/lib/kit-form.ts'
import { handleAdmin, saveKitSettings, saveSettings } from '../src/lib/admin.ts'
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

test('kit saves preserve every unrelated section, general settings preserve kits, and stale/invalid writes preserve bytes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bf-kits-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const catalog = kitFixture(),
    settings = {
      schema: 1,
      revision: 4,
      lobby: { pvpEnabled: false },
      gunBalance: { 'test:rifle': { draw_time: 1 } },
      campaignBalance: { '*': { max_tickets: 500 } },
      parcool: { allowedActions: [] },
      futureSection: { preserved: true },
    }
  writeFileSync(join(directory, 'kits.json'), JSON.stringify(catalog))
  writeFileSync(join(directory, 'settings.json'), JSON.stringify(settings))
  const custom = { ...structuredClone(catalog.kits[0].effective), id: 'custom' }
  const saved = saveKitSettings(
    directory,
    { expectedRevision: 4, kits: { custom }, fixedModeKits: { room: 'custom' } },
    'Admin',
  )
  assert.equal(saved.revision, 5)
  for (const key of ['lobby', 'gunBalance', 'campaignBalance', 'parcool', 'futureSection'])
    assert.deepEqual(saved[key], settings[key])
  const bytes = readFileSync(join(directory, 'settings.json'), 'utf8')
  assert.throws(
    () => saveKitSettings(directory, { expectedRevision: 4, kits: {}, fixedModeKits: {} }, 'Other'),
    (error) => error instanceof Response && error.status === 409,
  )
  assert.throws(
    () =>
      saveKitSettings(
        directory,
        { expectedRevision: 5, kits: {}, fixedModeKits: { room: 'custom' } },
        'Admin',
      ),
    (error) => error instanceof Response && error.status === 400,
  )
  assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), bytes)
  const general = saveSettings(directory, { expectedRevision: 5, rooms: { maxRooms: 3 } }, 'Admin')
  assert.deepEqual(general.kits, { custom })
  assert.deepEqual(general.fixedModeKits, { room: 'custom' })
  const deleted = saveKitSettings(
    directory,
    { expectedRevision: 6, kits: {}, fixedModeKits: { room: null } },
    'Admin',
  )
  assert.deepEqual(deleted.kits, {})
  assert.deepEqual(deleted.fixedModeKits, { room: null })
  const nearLimit = { schema: 1, revision: 7, futureSection: 'x'.repeat(1_048_000) }
  writeFileSync(join(directory, 'settings.json'), JSON.stringify(nearLimit))
  const largeBytes = readFileSync(join(directory, 'settings.json'), 'utf8')
  assert.throws(
    () =>
      saveKitSettings(
        directory,
        { expectedRevision: 7, kits: { custom }, fixedModeKits: { room: 'custom' } },
        'Admin',
      ),
    (error) => error instanceof Response && error.status === 413,
  )
  assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), largeBytes)
})

test('kit API is admin/owner-only and refuses missing authoritative catalog', async (t) => {
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
  assert.equal((await (await call('GET', OWNER)).json()).available, false)
  assert.equal(
    (await call('PUT', OWNER, { expectedRevision: 0, kits: {}, fixedModeKits: {} })).status,
    503,
  )
  writeFileSync(join(directory, 'kits.json'), JSON.stringify(kitFixture()))
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
    labels.map((label) => label.textContent),
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
