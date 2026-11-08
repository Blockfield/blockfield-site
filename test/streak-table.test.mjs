import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STREAK_ENTRIES,
  entriesToRows,
  parseStreakEntries,
  rowsToEntries,
  streakCycle,
  streakPeriod,
} from '../src/lib/streak-table.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsBody } from '../src/lib/settings-form.ts'
import { saveSettings, validateSettings } from '../src/lib/admin.ts'

test('default table round-trips through rows and matches the server period', () => {
  const rows = entriesToRows(DEFAULT_STREAK_ENTRIES)
  assert.deepEqual(
    rows.map((row) => row.kills),
    [2, 3, 5],
  )
  assert.equal(rows[2].items.length, 3)
  assert.deepEqual(rowsToEntries(rows), parseStreakEntries(DEFAULT_STREAK_ENTRIES))
  assert.equal(streakPeriod(DEFAULT_STREAK_ENTRIES), 5)
  const cycle2 = streakCycle(DEFAULT_STREAK_ENTRIES, 2)
  assert.deepEqual(
    cycle2.map((grant) => grant.count),
    [2, 2, 2, 2, 1],
  )
  assert.deepEqual(
    cycle2.map((grant) => grant.id),
    DEFAULT_STREAK_ENTRIES.map((entry) => entry.id),
  )
})

test('entries keep throwable and message payloads the editor does not touch', () => {
  const rows = entriesToRows(DEFAULT_STREAK_ENTRIES)
  const grenade = rows[2].items.find((item) => item.id === 'lrtactical:throwable')
  assert.equal(grenade.throwableId, 'lrtactical:m67')
  assert.equal(grenade.scale, false)
  const back = rowsToEntries(rows)
  assert.equal(
    back.find((entry) => entry.id === 'superbwarfare:armor_plate' && entry.kills === 5)?.scale,
    true,
  )
  assert.equal(
    back.find((entry) => entry.id === 'lrtactical:throwable')?.throwable_id,
    'lrtactical:m67',
  )
  assert.match(back[0].message ?? '', /\$\{name\}/)
})

test('rows reject empty item lists and duplicate thresholds', () => {
  assert.throws(() => rowsToEntries([{ kills: 2, items: [] }]), /хотя бы один предмет/)
  assert.throws(
    () =>
      rowsToEntries([
        { kills: 2, items: [{ id: 'minecraft:stick', count: 1, scale: true }] },
        { kills: 2, items: [{ id: 'minecraft:apple', count: 1, scale: false }] },
      ]),
    /уже есть/,
  )
  assert.throws(() => rowsToEntries([{ kills: 0, items: [] }]), /целое число от 1/)
})

test('parse mirrors the server table rules', () => {
  assert.deepEqual(parseStreakEntries([]), [])
  const minimal = parseStreakEntries([{ kills: 10, id: 'minecraft:apple', scale: false }])
  assert.deepEqual(minimal, [{ kills: 10, id: 'minecraft:apple', count: 1, scale: false }])
  const bad = [
    'x',
    [42],
    [{ kills: 0, id: 'minecraft:stick', scale: true }],
    [{ kills: 2, id: '', scale: true }],
    [{ kills: 2, id: 'not an id!!!', scale: true }],
    [{ kills: 2, id: 'minecraft:stick', count: 0, scale: true }],
    [{ kills: 2, id: 'minecraft:stick', count: 1 }],
    [{ kills: 2, id: 'minecraft:stick', count: 1, scale: 'yes' }],
    [{ kills: 2, id: 'lrtactical:throwable', count: 1, scale: false }],
    [
      {
        kills: 2,
        id: 'minecraft:stick',
        count: 1,
        scale: true,
        throwable_id: 'lrtactical:m67',
      },
    ],
    [{ kills: 2, id: 'minecraft:stick', count: 1, scale: true, message: 5 }],
  ]
  for (const table of bad)
    assert.throws(() => parseStreakEntries(table), Error, JSON.stringify(table))
  const oversized = Array.from({ length: 65 }, () => ({
    kills: 2,
    id: 'minecraft:stick',
    scale: true,
  }))
  assert.throws(() => parseStreakEntries(oversized), /не больше 64/)
  // Registry-unknown but well-formed ids pass here: membership stays server-side.
  assert.equal(parseStreakEntries([{ kills: 2, id: 'nope:missing', scale: true }]).length, 1)
})

test('settings body carries the validated table in the deathmatch section', () => {
  const table = parseStreakEntries([
    { kills: 2, id: 'minecraft:stick', scale: true },
    { kills: 10, id: 'minecraft:apple', count: 3, scale: false },
  ])
  const body = settingsBody(
    7,
    {
      pvpEnabled: 'true',
      lobby: {},
      rooms: {},
      deathmatch: {},
      lockedClasses: [],
      hadLocks: false,
      balance: {},
      streakRewards: table,
    },
    {},
    {},
  )
  assert.deepEqual(body.deathmatch, { streakRewards: table })
  const untouched = settingsBody(
    7,
    {
      pvpEnabled: 'true',
      lobby: {},
      rooms: {},
      deathmatch: { minPlayers: '2' },
      lockedClasses: [],
      hadLocks: false,
      balance: {},
    },
    { minPlayers: '2' },
    {},
  )
  assert.deepEqual(untouched.deathmatch ?? {}, {})
})

test('validateSettings accepts the table and rejects bad tables like the server', () => {
  assert.deepEqual(
    validateSettings({
      deathmatch: {
        minPlayers: 2,
        streakRewards: [{ kills: 2, id: 'minecraft:stick', scale: true }],
      },
    }),
    {
      deathmatch: {
        minPlayers: 2,
        streakRewards: [{ kills: 2, id: 'minecraft:stick', count: 1, scale: true }],
      },
    },
  )
  assert.deepEqual(validateSettings({ deathmatch: { streakRewards: [] } }), {
    deathmatch: { streakRewards: [] },
  })
  for (const table of [
    [{ kills: 0, id: 'minecraft:stick', scale: true }],
    [{ kills: 2, id: 'no colon', scale: true }],
    [{ kills: 2, id: 'minecraft:stick', scale: 'yes' }],
    'x',
  ])
    assert.throws(
      () => validateSettings({ deathmatch: { streakRewards: table } }),
      (e) => {
        assert.equal(e.status, 400)
        return true
      },
    )
  assert.throws(
    () => validateSettings({ deathmatch: { streakRewards: [], minPlayer: 1 } }),
    (e) => {
      assert.equal(e.status, 400)
      return true
    },
  )
})

test('null is the reset marker, accepted only as the whole table', () => {
  assert.deepEqual(validateSettings({ deathmatch: { streakRewards: null } }), {
    deathmatch: { streakRewards: null },
  })
  assert.deepEqual(validateSettings({ deathmatch: { minPlayers: 2, streakRewards: null } }), {
    deathmatch: { minPlayers: 2, streakRewards: null },
  })
  assert.throws(
    () => validateSettings({ deathmatch: { streakRewards: [null] } }),
    (e) => e.status === 400,
  )
})

test('settings body forwards the reset marker', () => {
  const body = settingsBody(
    7,
    {
      pvpEnabled: 'true',
      lobby: {},
      rooms: {},
      deathmatch: {},
      lockedClasses: [],
      hadLocks: false,
      balance: {},
      streakRewards: null,
    },
    {},
    {},
  )
  assert.deepEqual(body.deathmatch, { streakRewards: null })
})

test('a save that omits the table keeps the stored one; reset removes the key, never stores null', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-streak-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stored = () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  const table = [{ kills: 4, id: 'minecraft:apple', count: 3, scale: false }]
  let revision = 0
  const save = (body) => {
    saveSettings(dir, { expectedRevision: revision, ...body }, 'Admin')
    revision++
  }

  save({ deathmatch: { streakRewards: table } })
  assert.deepEqual(stored().deathmatch.streakRewards, table)
  save({ rooms: { maxRooms: 3 } })
  assert.deepEqual(stored().deathmatch.streakRewards, table, 'rooms-only save')
  save({ deathmatch: { minPlayers: 3 } })
  assert.deepEqual(stored().deathmatch, { minPlayers: 3, streakRewards: table }, 'numbers only')
  save({ deathmatch: { streakRewards: null, minPlayers: 3 } })
  assert.deepEqual(stored().deathmatch, { minPlayers: 3 }, 'reset keeps the numbers')

  save({ deathmatch: { streakRewards: [] } })
  save({ rooms: { maxRooms: 4 } })
  assert.deepEqual(stored().deathmatch.streakRewards, [], 'an empty table is a stored table')
  save({ deathmatch: { streakRewards: null } })
  assert.equal(stored().deathmatch, undefined, 'reset drops the emptied section')
  assert.doesNotMatch(readFileSync(join(dir, 'settings.json'), 'utf8'), /null/)
  save({ rooms: { maxRooms: 5 } })
  assert.equal(stored().deathmatch, undefined, 'nothing to carry over once reset')
})
