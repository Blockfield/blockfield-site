import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeGunValues,
  readGunBalance,
  validateGunCatalog,
  validateGunOverrides,
} from '../src/lib/gun-balance.ts'
import { weaponFields, BODY_PARTS } from '../src/lib/gun-fields.ts'
import { handleAdmin, readSettings, saveSettings } from '../src/lib/admin.ts'
import { database } from './storage.mjs'

const object = (fields, nullable = false) => ({ type: 'object', nullable, fields })
const number = (min, max) => ({ type: 'number', nullable: false, min, max })
const enumString = (values) => ({ type: 'string', nullable: false, values })
const array = (items, nullable = false) => ({ type: 'array', nullable, items })
const fixture = () => {
  const defaults = {
    draw_time: 0.32,
    rpm: 1220,
    ammo: 'tacz:9mm',
    bullet: { damage: 8, ignite: false, extra_damage: null },
    inaccuracy: { stand: 1, aim: 0.2 },
    recoil: { pitch: [{ time: 0, value: [0, 1] }] },
    fire_mode: ['semi'],
    allow_attachment_types: ['scope', null],
    script_param: { mode: 'old', AIM: 7 },
    future_field: 3,
    legacy_field: { AIM: 3 },
  }
  return {
    schema: 1,
    revision: 4,
    fields: object({
      draw_time: number(0, 60),
      rpm: { type: 'integer', nullable: false, min: 1, max: 1200 },
      ammo: { type: 'resource', nullable: false },
      bullet: object({
        damage: number(0, 10000),
        ignite: {
          ...object({
            entity: { type: 'boolean', nullable: false },
            block: { type: 'boolean', nullable: false },
          }),
          acceptsBoolean: true,
        },
        extra_damage: object(
          {
            damage_adjust: array(
              object({
                distance: { ...number(0, 10000), acceptsInfinite: true },
                damage: number(0, 10000),
              }),
            ),
          },
          true,
        ),
      }),
      inaccuracy: {
        type: 'map',
        nullable: true,
        keys: enumString(['stand', 'aim']),
        items: number(0, 10000),
      },
      recoil: object({
        pitch: array(object({ time: number(0, 60), value: array(number(-180, 180)) }), true),
      }),
      fire_mode: array(enumString(['auto', 'semi', 'burst'])),
      allow_attachment_types: array(enumString(['scope', 'stock', 'muzzle'])),
      script_param: { type: 'json', nullable: true },
      future_field: number(0, 10),
    }),
    guns: ['pistol', 'pistol_alias'].map((name) => ({
      id: `test:${name}`,
      data: 'test:pistol_data',
      name: 'gun.test.pistol.name',
      type: 'pistol',
      defaults: structuredClone(defaults),
      effective: { ...structuredClone(defaults), draw_time: 0.8 },
      warnings: ['Original rpm is outside edit bounds.'],
    })),
  }
}
const bodyFixture = () => {
  const catalog = fixture()
  catalog.bodyPartsEnabled = false
  catalog.fields.fields.body_part_multipliers = {
    ...object(Object.fromEntries(BODY_PARTS.map((part) => [part, number(0, 10)]))),
    serverOnly: true,
  }
  const baseline = Object.fromEntries(BODY_PARTS.map((part) => [part, 1]))
  for (const gun of catalog.guns) {
    gun.weaponKind = 'tacz'
    gun.sourceId = gun.id
    gun.defaults.body_part_multipliers = { ...baseline }
    gun.effective.body_part_multipliers = { ...baseline }
  }
  catalog.guns.push({
    id: 'item:superbwarfare/ak_47',
    data: 'item:superbwarfare/ak_47',
    sourceId: 'superbwarfare:ak_47',
    weaponKind: 'item',
    name: 'item.superbwarfare.ak_47',
    type: 'item',
    defaults: { body_part_multipliers: { ...baseline } },
    effective: { body_part_multipliers: { ...baseline } },
    warnings: [],
  })
  return catalog
}
const throwableFixture = () => {
  const catalog = bodyFixture()
  catalog.guns.push({
    ...structuredClone(catalog.guns[2]),
    id: 'throwable:lrtactical/smoke_grenade',
    data: 'throwable:lrtactical/smoke_grenade',
    sourceId: 'lrtactical:smoke_grenade',
    weaponKind: 'throwable',
    name: 'item.lrtactical.smoke_grenade',
    type: 'throwable',
  })
  return catalog
}
const meleeFixture = () => {
  const catalog = throwableFixture()
  catalog.guns.push({
    ...structuredClone(catalog.guns[2]),
    id: 'melee:lrtactical/dagger',
    data: 'melee:lrtactical/dagger',
    sourceId: 'lrtactical:dagger',
    weaponKind: 'melee',
    name: 'item.lrtactical.dagger',
    type: 'melee',
  })
  return catalog
}
const mountedFixture = () => {
  const catalog = meleeFixture()
  for (const [vehicleId, weaponName] of [
    ['superbwarfare:t_90a', 'Cannon'],
    ['superbwarfare:lav_150', 'Cannon'],
  ]) {
    const sourceId = `${vehicleId}/${Buffer.from(weaponName).toString('hex')}`
    const id = `mounted:${sourceId.replace(':', '/')}`
    catalog.guns.push({
      ...structuredClone(catalog.guns[2]),
      id,
      data: id,
      sourceId,
      vehicleId,
      weaponName,
      weaponKind: 'mounted',
      type: 'mounted',
      name: `${vehicleId} / ${weaponName}`,
    })
  }
  return catalog
}
const temp = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bf-gun-balance-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const rejected = (action, code = 400) =>
  assert.throws(action, (error) => error instanceof Response && error.status === code)
const writeCatalog = (directory, catalog = fixture()) =>
  writeFileSync(join(directory, 'gun-balance.json'), JSON.stringify(catalog))

test('native serverOnly metadata accepts optional booleans and keeps malformed catalogs unavailable', (t) => {
  const directory = temp(t)
  for (const flag of [undefined, false, true]) {
    const catalog = bodyFixture()
    if (flag === undefined) delete catalog.fields.fields.body_part_multipliers.serverOnly
    else catalog.fields.fields.body_part_multipliers.serverOnly = flag
    assert.equal(validateGunCatalog(catalog).fields.fields.body_part_multipliers.serverOnly, flag)
    writeCatalog(directory, catalog)
    const availability = readGunBalance(directory)
    assert.equal(availability.available, true)
    assert.equal(availability.catalog.fields.fields.body_part_multipliers.serverOnly, flag)
  }
  for (const flag of [null, 0, 1, 'true', [], {}]) {
    const catalog = bodyFixture()
    catalog.fields.fields.body_part_multipliers.serverOnly = flag
    rejected(() => validateGunCatalog(catalog))
    writeCatalog(directory, catalog)
    assert.equal(readGunBalance(directory).available, false)
  }
})

test('body catalog keeps item identities exact and rejects corrupt schemas, native item fields and unsafe coefficients', () => {
  const catalog = validateGunCatalog(bodyFixture())
  assert.deepEqual(Object.keys(weaponFields(catalog, catalog.guns[2]).fields), [
    'body_part_multipliers',
  ])
  assert.equal(weaponFields(catalog, catalog.guns[0]), catalog.fields)
  for (const mutate of [
    (value) => (value.guns[2].sourceId = 'superbwarfare:other'),
    (value) => (value.bodyPartsEnabled = 'false'),
    (value) => (value.guns[2].weaponKind = 'other'),
    (value) => delete value.guns[2].sourceId,
    (value) => (value.guns[0].sourceId = 'test:backing_data'),
    (value) => (value.guns[2].defaults.draw_time = 1),
    (value) => (value.guns[2].effective.rpm = 800),
    (value) => delete value.guns[2].defaults.body_part_multipliers,
    (value) => (value.guns[0].defaults.body_part_multipliers.head = 2),
    (value) => (value.guns[0].effective.body_part_multipliers.head = 11),
    (value) => (value.fields.fields.body_part_multipliers.fields.head.max = 11),
    (value) => (value.fields.fields.body_part_multipliers.nullable = true),
    (value) => (value.fields.fields.body_part_multipliers.acceptsBoolean = true),
    (value) => (value.fields.fields.body_part_multipliers.fields.head.acceptsInfinite = true),
    (value) => (value.fields.fields.body_part_multipliers.fields.unknown = number(0, 10)),
  ]) {
    const invalid = bodyFixture()
    mutate(invalid)
    rejected(() => validateGunCatalog(invalid))
  }
})

test('per-index body coefficients are independent of native aliases; item overrides accept only bounded body fields', () => {
  const catalog = validateGunCatalog(bodyFixture())
  const overrides = {
    'test:pistol': { bullet: { damage: 9 }, body_part_multipliers: { head: 2, torso: 1 } },
    'test:pistol_alias': { bullet: { damage: 9 }, body_part_multipliers: { head: 3 } },
    'item:superbwarfare/ak_47': { body_part_multipliers: { left_arm: 0, right_leg: 10 } },
  }
  assert.deepEqual(validateGunOverrides(overrides, catalog), {
    ...overrides,
    'test:pistol': { bullet: { damage: 9 }, body_part_multipliers: { head: 2 } },
  })
  assert.deepEqual(
    validateGunOverrides(
      {
        'test:pistol': { bullet: { damage: 9 } },
        'test:pistol_alias': { body_part_multipliers: { head: 2 } },
      },
      catalog,
    ),
    {
      'test:pistol': { bullet: { damage: 9 } },
      'test:pistol_alias': { body_part_multipliers: { head: 2 } },
    },
  )
  assert.deepEqual(
    validateGunOverrides({ 'test:pistol': { body_part_multipliers: { head: 1 } } }, catalog),
    {},
  )
  for (const body of [
    null,
    [],
    { head: null },
    { head: true },
    { head: NaN },
    { head: Infinity },
    { head: -0.1 },
    { head: 10.1 },
    { unknown: 1 },
  ])
    rejected(() =>
      validateGunOverrides({ 'test:pistol': { body_part_multipliers: body } }, catalog),
    )
  for (const native of [{ rpm: 800 }, { draw_time: 1 }, { script_param: {} }])
    rejected(() => validateGunOverrides({ 'item:superbwarfare/ak_47': native }, catalog))
  rejected(() =>
    validateGunOverrides({ 'item:unknown/gun': { body_part_multipliers: { head: 2 } } }, catalog),
  )
  rejected(() =>
    validateGunOverrides(
      {
        ...overrides,
        'test:pistol_alias': { bullet: { damage: 10 }, body_part_multipliers: { head: 3 } },
      },
      catalog,
    ),
  )
})

test('throwable and melee index identities remain body-only and reject native fields or mixed typed IDs', () => {
  for (const [kind, sourceId, index] of [
    ['throwable', 'lrtactical:smoke_grenade', 3],
    ['melee', 'lrtactical:dagger', 4],
  ]) {
    const catalog = validateGunCatalog(meleeFixture())
    const id = `${kind}:${sourceId.replace(':', '/')}`
    assert.deepEqual(Object.keys(weaponFields(catalog, catalog.guns[index]).fields), [
      'body_part_multipliers',
    ])
    assert.deepEqual(
      validateGunOverrides({ [id]: { body_part_multipliers: { head: 2, torso: 1 } } }, catalog),
      {
        [id]: { body_part_multipliers: { head: 2 } },
      },
    )
    for (const native of [{ rpm: 800 }, { draw_time: 1 }, { script_param: {} }])
      rejected(() => validateGunOverrides({ [id]: native }, catalog))
    rejected(() =>
      validateGunOverrides(
        { [`${kind}:lrtactical/unknown`]: { body_part_multipliers: { head: 2 } } },
        catalog,
      ),
    )
    for (const mutate of [
      (row) => (row.id = `item:${sourceId.replace(':', '/')}`),
      (row) => (row.data = sourceId),
      (row) => (row.sourceId = 'lrtactical:other_weapon'),
      (row) => (row.type = 'item'),
      (row) => (row.defaults.rpm = 800),
      (row) => (row.effective.damage = 5),
    ]) {
      const invalid = meleeFixture()
      mutate(invalid.guns[index])
      rejected(() => validateGunCatalog(invalid))
    }
  }
  const catalog = validateGunCatalog(meleeFixture())
  for (const unsupported of [
    'item:lrtactical/melee',
    'melee:lrtactical/karambit',
    'melee:lrtactical/baseball_bat',
  ])
    rejected(() =>
      validateGunOverrides({ [unsupported]: { body_part_multipliers: { head: 2 } } }, catalog),
    )
})

test('body saves use the existing revision and preserve settings while general saves retain the body overrides', (t) => {
  const directory = temp(t)
  writeCatalog(directory, bodyFixture())
  writeFileSync(
    join(directory, 'settings.json'),
    JSON.stringify({ schema: 1, revision: 4, rooms: { maxRooms: 3 } }),
  )
  const gunBalance = {
    'test:pistol': { body_part_multipliers: { head: 2 } },
    'item:superbwarfare/ak_47': { body_part_multipliers: { torso: 0.75 } },
  }
  const saved = saveSettings(directory, { expectedRevision: 4, gunBalance }, 'Admin', true)
  assert.deepEqual(saved.gunBalance, gunBalance)
  assert.deepEqual(saved.rooms, { maxRooms: 3 })
  const before = readFileSync(join(directory, 'settings.json'), 'utf8')
  rejected(
    () => saveSettings(directory, { expectedRevision: 4, gunBalance: {} }, 'Admin', true),
    409,
  )
  assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), before)
  const general = saveSettings(
    directory,
    { expectedRevision: 5, lobby: { pvpEnabled: false } },
    'Admin',
  )
  assert.deepEqual(general.gunBalance, gunBalance)
  const reset = saveSettings(directory, { expectedRevision: 6, gunBalance: {} }, 'Admin', true)
  assert.equal(Object.hasOwn(reset, 'gunBalance'), false)
})

test('mounted tuples are body-only, case-sensitive and independent of the shared vehicle-gun item', (t) => {
  const catalog = validateGunCatalog(mountedFixture())
  const first = catalog.guns[5],
    second = catalog.guns[6]
  assert.deepEqual(Object.keys(weaponFields(catalog, first).fields), ['body_part_multipliers'])
  const overrides = {
    [first.id]: { body_part_multipliers: { head: 0.4 } },
    [second.id]: { body_part_multipliers: { head: 0.8 } },
  }
  assert.deepEqual(validateGunOverrides(overrides, catalog), overrides)
  for (const id of ['item:superbwarfare/vehicle_gun', 'mounted:superbwarfare/t_90a/4d697373696e67'])
    rejected(() => validateGunOverrides({ [id]: { body_part_multipliers: { head: 2 } } }, catalog))
  rejected(() => validateGunOverrides({ [first.id]: { rpm: 80 } }, catalog))
  for (const mutate of [
    (row) => (row.weaponName = 'cannon'),
    (row) => (row.vehicleId = 'superbwarfare:lav_150'),
    (row) => (row.sourceId = 'superbwarfare:t_90a/43616e6e6f6e00'),
    (row) => (row.type = 'item'),
    (row) => (row.defaults.rpm = 80),
    (row) => delete row.weaponName,
    (row) => delete row.vehicleId,
  ]) {
    const invalid = mountedFixture()
    mutate(invalid.guns[5])
    rejected(() => validateGunCatalog(invalid))
  }
  const directory = temp(t)
  writeCatalog(directory, catalog)
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ schema: 1, revision: 4 }))
  const saved = saveSettings(
    directory,
    { expectedRevision: 4, gunBalance: overrides },
    'Admin',
    true,
  )
  assert.deepEqual(saved.gunBalance, overrides)
  rejected(
    () => saveSettings(directory, { expectedRevision: 4, gunBalance: {} }, 'Admin', true),
    409,
  )
  assert.deepEqual(readSettings(directory).settings.gunBalance, overrides)
})

test('mounted native names use canonical fatal UTF8 decoding and the full 256-character ID ceiling', () => {
  const rowFor = (name, hex = Buffer.from(name).toString('hex')) => {
    const catalog = mountedFixture(),
      row = catalog.guns[5]
    row.weaponName = name
    row.sourceId = `${row.vehicleId}/${hex}`
    row.id = row.data = `mounted:${row.sourceId.replace(':', '/')}`
    return catalog
  }
  for (const name of ['Главное орудие', 'Gun/2', '\uFEFFMain', ' ', 'a'.repeat(114)])
    assert.equal(validateGunCatalog(rowFor(name)).guns[5].weaponName, name)
  for (const [name, hex] of [
    ['�', 'ff'],
    ['/', 'c0af'],
    ['�', 'eda080'],
    ['Cannon', '43616E6e6f6e'],
    ['', ''],
  ])
    rejected(() => validateGunCatalog(rowFor(name, hex)))
  rejected(() => validateGunCatalog(rowFor('a'.repeat(115))))
  rejected(() => validateGunCatalog(rowFor('я'.repeat(65))))
  const mixed = mountedFixture()
  mixed.guns[2].vehicleId = 'superbwarfare:t_90a'
  mixed.guns[2].weaponName = 'Cannon'
  rejected(() => validateGunCatalog(mixed))
})

test('typed multipliers save through gunBalance and keep every item and index override independent', (t) => {
  const directory = temp(t)
  writeCatalog(directory, meleeFixture())
  writeFileSync(
    join(directory, 'settings.json'),
    JSON.stringify({ schema: 1, revision: 4, rooms: { maxRooms: 3 } }),
  )
  const gunBalance = {
    'test:pistol': { body_part_multipliers: { head: 2 } },
    'item:superbwarfare/ak_47': { body_part_multipliers: { head: 3 } },
    'throwable:lrtactical/smoke_grenade': { body_part_multipliers: { head: 4 } },
    'melee:lrtactical/dagger': { body_part_multipliers: { head: 5 } },
  }
  const saved = saveSettings(directory, { expectedRevision: 4, gunBalance }, 'Admin', true)
  assert.deepEqual(saved.gunBalance, gunBalance)
  assert.deepEqual(saved.rooms, { maxRooms: 3 })
})

test('recursive fields come from metadata; legacy defaults reset without being rewritten', () => {
  const catalog = validateGunCatalog(fixture()),
    before = structuredClone(catalog)
  const overrides = validateGunOverrides(
    {
      'test:pistol': {
        draw_time: 0.32,
        rpm: 1220,
        bullet: {
          damage: 9,
          ignite: { entity: true },
          extra_damage: { damage_adjust: [{ distance: 'infinite', damage: 4 }] },
        },
        inaccuracy: { aim: 0.5 },
        recoil: { pitch: [{ time: 0, value: [-10, 20] }] },
        script_param: { AIM: 7, nested: { steps: [1, true, null] } },
        future_field: 5,
        legacy_field: { AIM: 3 },
        allow_attachment_types: ['scope', null],
      },
    },
    catalog,
  )
  assert.deepEqual(overrides, {
    'test:pistol': {
      bullet: {
        damage: 9,
        ignite: { entity: true },
        extra_damage: { damage_adjust: [{ distance: 'infinite', damage: 4 }] },
      },
      inaccuracy: { aim: 0.5 },
      recoil: { pitch: [{ time: 0, value: [-10, 20] }] },
      script_param: { nested: { steps: [1, true, null] } },
      future_field: 5,
    },
  })
  assert.deepEqual(catalog, before)
  assert.deepEqual(validateGunOverrides({ 'test:pistol': catalog.guns[0].defaults }, catalog), {})
  assert.deepEqual(validateGunOverrides({}, catalog), {})
  assert.deepEqual(validateGunOverrides({ 'test:pistol': { inaccuracy: null } }, catalog), {
    'test:pistol': { inaccuracy: null },
  })
  assert.deepEqual(mergeGunValues(catalog.guns[0].defaults, overrides['test:pistol']).inaccuracy, {
    stand: 1,
    aim: 0.5,
  })
})

test('changed nested data rejects unknown fields, wrong types, nonfinite values and bounds', () => {
  const catalog = validateGunCatalog(fixture())
  for (const override of [
    { draw_time: '0.8' },
    { rpm: 1221 },
    { rpm: 3.5 },
    { draw_time: Infinity },
    { bullet: { damage: NaN } },
    { bullet: { ignite: 1 } },
    { bullet: null },
    { bullet: { invented: 1 } },
    { inaccuracy: { unknown: 1 } },
    { recoil: { pitch: [{ value: [-181, 1] }] } },
    { fire_mode: ['unknown'] },
    { ammo: 'bad ID' },
    { future_field: -1 },
    { legacy_field: { AIM: 4 } },
    { allow_attachment_types: ['stock', null] },
    { script_param: { steps: Array(257).fill(1) } },
  ])
    rejected(() => validateGunOverrides({ 'test:pistol': override }, catalog))
  rejected(() => validateGunOverrides({ 'test:missing': {} }, catalog))
  rejected(() => validateGunOverrides({ 'test:pistol': null }, catalog))
  rejected(() => validateGunOverrides(null, catalog))
})

test('aliases sharing data accept matching effective changes and reject contradictory changes atomically', () => {
  const catalog = validateGunCatalog(fixture())
  assert.deepEqual(
    validateGunOverrides(
      {
        'test:pistol': { inaccuracy: { AIM: 0.5 } },
        'test:pistol_alias': { inaccuracy: { aim: 0.5 } },
      },
      catalog,
    ),
    {
      'test:pistol': { inaccuracy: { aim: 0.5 } },
      'test:pistol_alias': { inaccuracy: { aim: 0.5 } },
    },
  )
  rejected(() =>
    validateGunOverrides({ 'test:pistol': { inaccuracy: { AIM: 0.5, aim: 0.7 } } }, catalog),
  )
  assert.deepEqual(
    validateGunOverrides(
      {
        'test:pistol': { bullet: { damage: 9 } },
        'test:pistol_alias': { bullet: { damage: 9 }, rpm: 1220 },
      },
      catalog,
    ),
    {
      'test:pistol': { bullet: { damage: 9 } },
      'test:pistol_alias': { bullet: { damage: 9 } },
    },
  )
  assert.doesNotThrow(() =>
    validateGunOverrides({ 'test:pistol': { draw_time: 0.8 }, 'test:pistol_alias': {} }, catalog),
  )
  rejected(() =>
    validateGunOverrides(
      { 'test:pistol': { bullet: { damage: 9 } }, 'test:pistol_alias': { bullet: { damage: 10 } } },
      catalog,
    ),
  )
})

test('catalog reader fails closed for absent/malformed schema and retains native defaults only', (t) => {
  const directory = temp(t)
  assert.deepEqual(Object.keys(readGunBalance(directory)).sort(), ['available', 'error'])
  writeFileSync(join(directory, 'gun-balance.json'), '{broken')
  assert.equal(readGunBalance(directory).available, false)
  for (const mutate of [
    (catalog) => {
      catalog.schema = 2
    },
    (catalog) => {
      catalog.fields.fields.draw_time.min = NaN
    },
    (catalog) => {
      catalog.fields.fields.inaccuracy.keys = number(0, 10)
    },
    (catalog) => {
      catalog.guns[1].id = catalog.guns[0].id
    },
    (catalog) => {
      catalog.guns[0].data = 'invalid'
    },
    (catalog) => {
      delete catalog.guns[0].defaults.draw_time
    },
    (catalog) => {
      catalog.guns[0].effective.draw_time = null
    },
  ]) {
    const catalog = fixture()
    mutate(catalog)
    writeCatalog(directory, catalog)
    assert.equal(readGunBalance(directory).available, false)
  }
  writeCatalog(directory)
  assert.equal(readGunBalance(directory).available, true)
  writeFileSync(join(directory, 'gun-balance.json'), ' '.repeat(8 * 1024 * 1024 + 1))
  assert.equal(readGunBalance(directory).available, false)
})

test('balance saves preserve unrelated sections, refuse stale/invalid writes and reset by omission', (t) => {
  const directory = temp(t)
  writeCatalog(directory)
  const current = {
    schema: 1,
    revision: 9,
    lobby: { pvpEnabled: false, pvpCooldownSeconds: 40 },
    parcool: { allowedActions: ['FastRun'] },
    custom: { untouched: true },
    gunBalance: { 'test:pistol': { draw_time: 0.8 } },
  }
  const settingsFile = join(directory, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify(current))
  const saved = saveSettings(
    directory,
    { expectedRevision: 9, gunBalance: { 'test:pistol': { bullet: { damage: 9 } } } },
    'Adm',
    true,
  )
  assert.deepEqual(saved.lobby, current.lobby)
  assert.deepEqual(saved.parcool, current.parcool)
  assert.deepEqual(saved.custom, current.custom)
  assert.equal(saved.revision, 10)
  assert.equal(saved.updatedBy, 'Adm')
  const before = readFileSync(settingsFile, 'utf8')
  rejected(() => saveSettings(directory, { expectedRevision: 9, gunBalance: {} }, 'Adm', true), 409)
  rejected(() =>
    saveSettings(
      directory,
      { expectedRevision: 10, gunBalance: { 'test:pistol': { draw_time: -1 } } },
      'Adm',
      true,
    ),
  )
  rejected(() => saveSettings(directory, { expectedRevision: 10, gunBalance: null }, 'Adm', true))
  rejected(() => saveSettings(directory, null, 'Adm', true))
  assert.equal(readFileSync(settingsFile, 'utf8'), before)
  const general = saveSettings(
    directory,
    { expectedRevision: 10, lobby: { pvpEnabled: true } },
    'Adm',
  )
  assert.deepEqual(general.gunBalance, saved.gunBalance)
  const reset = saveSettings(directory, { expectedRevision: 11 }, 'Adm', true)
  assert.equal(Object.hasOwn(reset, 'gunBalance'), false)
  assert.deepEqual(reset.lobby, general.lobby)
  assert.equal(readSettings(directory).settings.revision, 12)
  assert.deepEqual(readdirSync(directory).sort(), ['gun-balance.json', 'settings.json'])
  rmSync(join(directory, 'gun-balance.json'))
  rejected(
    () => saveSettings(directory, { expectedRevision: 12, gunBalance: {} }, 'Adm', true),
    503,
  )
})

test('balance API requires admin/owner, GET never writes, and applied status remains server authoritative', async (t) => {
  const directory = temp(t),
    env = { ...process.env },
    store = await database(t)
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
    Object.assign(process.env, env)
  })
  const owner = '1'.repeat(32),
    admin = '2'.repeat(32),
    moderator = '3'.repeat(32),
    builder = '4'.repeat(32)
  Object.assign(process.env, {
    NODE_ENV: 'test',
    BLOCKFIELD_OWNER_UUIDS: owner,
    BLOCKFIELD_SETTINGS_DIR: directory,
    BLOCKFIELD_ADMIN_DIR: directory,
  })
  await store.setStaff(admin, 'Adm', 'admin', 'seed')
  await store.setStaff(moderator, 'Mod', 'moderator', 'seed')
  await store.setStaff(builder, 'Builder', 'builder', 'seed')
  // A permissive Workshop ACL cannot grant site settings authority.
  writeFileSync(
    join(directory, 'members.json'),
    JSON.stringify({ schema: 1, members: [{ draslId: builder, name: 'Builder', role: 'admin' }] }),
  )
  writeCatalog(directory, bodyFixture())
  writeFileSync(
    join(directory, 'applied.json'),
    JSON.stringify({ revision: 1, gunBalance: { accepted: false, error: 'server validation' } }),
  )
  const call = async (id, method, path, body) => {
    process.env.BLOCKFIELD_ADMIN_DEV_USER = `${id}:Tester`
    const url = new URL(`http://site/api/admin/${path}`)
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return handleAdmin({ request, url, cookies: { get: () => undefined } }, path, store).catch(
      (error) => error,
    )
  }
  const files = readdirSync(directory)
  for (const id of [owner, admin]) {
    const response = await call(id, 'GET', 'gun-balance')
    assert.equal(response.status, 200)
    const availability = await response.json()
    assert.equal(availability.available, true)
    assert.equal(availability.catalog.fields.fields.body_part_multipliers.serverOnly, true)
  }
  for (const id of [moderator, builder])
    assert.equal((await call(id, 'GET', 'gun-balance')).status, 403)
  assert.deepEqual(readdirSync(directory), files)
  assert.equal((await store.db.prepare('SELECT count(*) AS n FROM admin_audit').get()).n, 0)
  for (const id of [moderator, builder])
    assert.equal(
      (
        await call(id, 'PUT', 'gun-balance', {
          expectedRevision: 0,
          gunBalance: { 'item:superbwarfare/ak_47': { body_part_multipliers: { head: 2 } } },
        })
      ).status,
      403,
    )
  const response = await call(admin, 'PUT', 'gun-balance', {
    expectedRevision: 0,
    gunBalance: {
      'test:pistol': { draw_time: 0.8, body_part_multipliers: { head: 2 } },
      'item:superbwarfare/ak_47': { body_part_multipliers: { torso: 0.75 } },
    },
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).settings.revision, 1)
  const view = await (await call(admin, 'GET', 'settings')).json()
  assert.equal(view.gunBalance.available, true)
  assert.equal(view.applied.gunBalance.accepted, false)
  assert.deepEqual(view.settings.gunBalance['item:superbwarfare/ak_47'], {
    body_part_multipliers: { torso: 0.75 },
  })
  assert.equal(
    (await call(admin, 'PUT', 'gun-balance', { expectedRevision: 0, gunBalance: {} })).status,
    409,
  )
  const invalid = bodyFixture()
  invalid.fields.fields.body_part_multipliers.serverOnly = 'true'
  writeCatalog(directory, invalid)
  assert.equal((await (await call(admin, 'GET', 'gun-balance')).json()).available, false)
  const beforeInvalidWrite = readFileSync(join(directory, 'settings.json'), 'utf8')
  assert.equal(
    (await call(admin, 'PUT', 'gun-balance', { expectedRevision: 1, gunBalance: {} })).status,
    503,
  )
  assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), beforeInvalidWrite)
  rmSync(join(directory, 'gun-balance.json'))
  const unavailable = await (await call(admin, 'GET', 'gun-balance')).json()
  assert.equal(unavailable.available, false)
  assert.equal(Object.hasOwn(unavailable, 'catalog'), false)
  assert.equal(
    (await call(owner, 'PUT', 'gun-balance', { expectedRevision: 1, gunBalance: {} })).status,
    503,
  )
})
