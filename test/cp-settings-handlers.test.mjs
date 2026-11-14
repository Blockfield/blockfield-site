import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveSettingsCp,
  saveKitSettingsCp,
  saveMapAvailabilityCp,
  saveAiLimitsCp,
  saveWorkshopAiSettingsCp,
  readSettingsCpView,
  readAiLimitsCpView,
  readMapAvailabilityCp,
} from '../src/lib/admin.ts'
import { kitFixture } from './kits-fixture.mjs'
import { fakeCp, withCp } from './cp-fake.mjs'

/** Acting admin the settings saves assert to CP (any stable UUID). */
const ACTOR = 'd94f8b1e-2c3a-4d5e-8f70-91a2b3c4d5e6'

const status = (error) =>
  error instanceof Response ? error.status : assert.fail(`expected Response, got ${error}`)
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-cp-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const seed = (dir, name, value) => writeFileSync(join(dir, name), JSON.stringify(value))

test('CP settings CAS on a real handler: concurrent writers, one wins with 409', async (t) => {
  await withCp(t, async (dir, seen) => {
    const body = { expectedRevision: 0, rooms: { maxRooms: 2 } }
    const [first, second] = await Promise.allSettled([
      saveSettingsCp(dir, body, 'A', ACTOR),
      saveSettingsCp(dir, { expectedRevision: 0, rooms: { maxRooms: 3 } }, 'B', ACTOR),
    ])
    const won = [first, second].find((r) => r.status === 'fulfilled')
    const lost = [first, second].find((r) => r.status === 'rejected')
    assert.ok(won, 'one writer wins')
    assert.equal(won.value.settings.revision, 1)
    assert.ok(lost, 'the other writer loses')
    assert.equal(lost.status, 'rejected')
    const reason = lost.status === 'rejected' ? lost.reason : assert.fail('unreachable')
    assert.equal(status(reason), 409)
    assert.match(await reason.text(), /уже изменил/)
    assert.equal(seen.filter(([ns]) => ns === 'rooms').length, 1)
    const view = await readSettingsCpView(dir)
    assert.equal(view.settings.revision, 1)
  })
})

test('CP settings PATCH carries the acting admin account to CP', async (t) => {
  await withCp(t, async (dir, seen) => {
    await saveSettingsCp(
      dir,
      { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
      'A',
      ACTOR,
    )
    const rooms = seen.filter(([ns]) => ns === 'rooms')
    assert.equal(rooms.length, 1)
    assert.equal(rooms[0][1].actorAccountId, ACTOR)
  })
})

test('CP ai-limits is owner-only: admin is refused before any CP call', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'ai-limits.json', {
      schema: 1,
      revision: 0,
      currency: 'USD',
      mode: 'session',
      sessions: {},
      builders: {},
    })
    const body = { expectedRevision: 0, mode: 'builder', sessions: {}, builders: {} }
    await assert.rejects(saveAiLimitsCp(dir, body, 'admin', ACTOR), (e) => status(e) === 403)
    assert.equal(seen.length, 0)
    const policy = await saveAiLimitsCp(dir, body, 'owner', ACTOR)
    assert.equal(policy.policy.revision, 1)
    assert.equal(policy.policy.mode, 'builder')
    assert.equal(seen.length, 1)
    assert.equal(seen[0][0], 'ai-limits')
    assert.deepEqual(seen[0][1].patch, { mode: 'builder' }, 'unchanged keys are absent')
    assert.equal(typeof seen[0][1].idempotencyKey, 'string')
  })
})

test('CP maps round-trip: PATCH disabledMapIds, GET view shows it', async (t) => {
  await withCp(t, async (dir) => {
    const saved = await saveMapAvailabilityCp(
      dir,
      { mapId: 'arena1', enabled: false, expectedRevision: 0 },
      'A',
      ACTOR,
    )
    assert.deepEqual(saved.settings.disabledMapIds, ['arena1'])
    const view = await readSettingsCpView(dir)
    assert.deepEqual(view.settings.disabledMapIds, ['arena1'])
    assert.equal(view.settings.revision, 1)
    const availability = await readMapAvailabilityCp()
    assert.deepEqual(availability.disabledMapIds, ['arena1'])
    assert.equal(availability.revision, 1)
  })
})

test('CP GET view is CP-only: revision is the max initialized revision', async (t) => {
  await withCp(t, async (dir) => {
    await saveSettingsCp(
      dir,
      { expectedRevision: 0, lobby: { pvpEnabled: true }, rooms: { maxRooms: 2 } },
      'A',
      ACTOR,
    )
    const view = await readSettingsCpView(dir)
    assert.deepEqual(view.settings.lobby, { pvpEnabled: true })
    assert.deepEqual(view.settings.rooms, { maxRooms: 2 })
    assert.equal(view.settings.revision, 1, 'max across namespaces')
    assert.deepEqual(view.applied, { revision: 0, attemptedRevision: 0, errors: [] })
  })
})
test('CP settings requires the carried base revision: missing base is a 409', async (t) => {
  await withCp(t, async (dir, seen) => {
    const first = await saveSettingsCp(
      dir,
      { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
      'A',
      ACTOR,
    )
    assert.equal(first.settings.revision, 1)
    await assert.rejects(
      saveSettingsCp(dir, { expectedRevision: 1, rooms: { maxRooms: 3 } }, 'B', ACTOR),
      (e) => status(e) === 409,
    )
    assert.equal(
      seen.filter(([ns]) => ns === 'rooms').length,
      1,
      'no second rooms PATCH after the refused save',
    )
  })
})

test('CP settings surfaces a stale carried base as 409', async (t) => {
  await withCp(t, async (dir) => {
    await saveSettingsCp(
      dir,
      { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
      'A',
      ACTOR,
    )
    await assert.rejects(
      saveSettingsCp(
        dir,
        { expectedRevision: 1, rooms: { maxRooms: 3 }, cpRevisions: { rooms: 0 } },
        'B',
        ACTOR,
      ),
      (e) => status(e) === 409,
    )
  })
})

test('CP settings PATCHes only changed namespaces', async (t) => {
  await withCp(t, async (dir, seen) => {
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 0,
        lobby: { pvpEnabled: true },
        rooms: { maxRooms: 2 },
        cpRevisions: {},
      },
      'A',
      ACTOR,
    )
    const roomsPatches = seen.filter(([ns]) => ns === 'rooms').length
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 1,
        lobby: { pvpEnabled: false },
        rooms: { maxRooms: 2 },
        cpRevisions: { gameplay: 1, rooms: 1 },
      },
      'A',
      ACTOR,
    )
    assert.equal(
      seen.filter(([ns]) => ns === 'rooms').length,
      roomsPatches,
      'unchanged rooms are not re-PATCHed',
    )
    assert.equal(seen.filter(([ns]) => ns === 'gameplay').length, 2, 'changed lobby is PATCHed')
  })
})

test('CP settings partial commit names what was saved', async (t) => {
  await withCp(t, async (dir) => {
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 0,
        lobby: { pvpEnabled: true },
        rooms: { maxRooms: 2 },
        cpRevisions: {},
      },
      'A',
      ACTOR,
    )
    const error = await saveSettingsCp(
      dir,
      {
        expectedRevision: 1,
        lobby: { pvpEnabled: false },
        rooms: { maxRooms: 3 },
        cpRevisions: { gameplay: 1, rooms: 0 },
      },
      'B',
      ACTOR,
    ).then(
      () => assert.fail('expected a partial-commit failure'),
      (e) => e,
    )
    assert.equal(status(error), 409)
    const text = await error.text()
    assert.match(text, /lobby/, 'names the committed section')
    assert.match(text, /rooms/, 'names the failed section')
    const view = await readSettingsCpView(dir)
    assert.deepEqual(view.settings.lobby, { pvpEnabled: false }, 'committed section lands')
    assert.deepEqual(view.settings.rooms, { maxRooms: 2 }, 'failed section keeps the old value')
  })
})

test('CP settings save settles namespaces in parallel (wall clock)', async (t) => {
  // 4 namespaces x 400 ms per PATCH: sequential settle would take >= 1600 ms.
  const started = Date.now()
  await withCp(
    t,
    async (dir, seen) => {
      const saved = await saveSettingsCp(
        dir,
        {
          expectedRevision: 0,
          lobby: { pvpEnabled: true },
          rooms: { maxRooms: 2 },
          deathmatch: { minPlayers: 3 },
          classLocks: ['tech'],
          cpRevisions: {},
        },
        'A',
        ACTOR,
      )
      assert.equal(saved.settings.revision, 1)
      assert.deepEqual(
        seen.map(([namespace]) => namespace).sort(),
        ['classLocks', 'deathmatch', 'gameplay', 'rooms'],
        'one PATCH per changed namespace',
      )
      const view = await readSettingsCpView(dir)
      assert.deepEqual(view.settings.lobby, { pvpEnabled: true })
      assert.deepEqual(view.settings.rooms, { maxRooms: 2 })
      assert.deepEqual(view.settings.deathmatch, { minPlayers: 3 })
      assert.deepEqual(view.settings.classLocks, ['tech'])
    },
    { patchDelayMs: 400 },
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1200, `4 x 400 ms PATCHes settled in ${elapsed} ms, expected ~400 ms`)
})

test('CP settings parallel save names every failed namespace, claims none saved', async (t) => {
  await withCp(
    t,
    async (dir) => {
      const error = await saveSettingsCp(
        dir,
        {
          expectedRevision: 0,
          lobby: { pvpEnabled: true },
          rooms: { maxRooms: 2 },
          deathmatch: { minPlayers: 3 },
          classLocks: ['tech'],
          cpRevisions: {},
        },
        'A',
        ACTOR,
      ).then(
        () => assert.fail('expected a partial failure'),
        (error) => error,
      )
      assert.equal(status(error), 503)
      const text = await error.text()
      assert.match(text, /rooms/, 'names the first failed namespace')
      assert.match(text, /deathmatch/, 'names the second failed namespace')
      assert.doesNotMatch(text, /Сохранено/, 'unknown outcome claims nothing as saved')
      const view = await readSettingsCpView(dir)
      assert.deepEqual(view.settings.lobby, { pvpEnabled: true }, 'succeeded namespace lands')
      assert.deepEqual(view.settings.classLocks, ['tech'], 'succeeded namespace lands')
      assert.equal(view.settings.rooms, undefined, 'failed namespace keeps the old value')
      assert.equal(view.settings.deathmatch, undefined, 'failed namespace keeps the old value')
    },
    { failNamespaces: ['rooms', 'deathmatch'] },
  )
})

test('CP gun-only path PATCHes only gunBalance', async (t) => {
  await withCp(t, async (dir, seen) => {
    const saved = await saveSettingsCp(
      dir,
      {
        expectedRevision: 0,
        gunBalance: { 'tacz:m4a1': { draw_time: 0.5 } },
        cpRevisions: {},
      },
      'A',
      ACTOR,
      true,
    )
    assert.equal(saved.settings.revision, 1)
    assert.deepEqual(
      seen.map(([ns]) => ns),
      ['gunBalance'],
      'gun-only save touches no other namespace (single PATCH)',
    )
    const view = await readSettingsCpView(dir)
    assert.deepEqual(view.settings.gunBalance, { 'tacz:m4a1': { draw_time: 0.5 } })
    assert.equal(view.settings.lobby, undefined, 'untouched sections stay absent')
  })
})

test('CP reset-all gun overrides sends a null-delete PATCH', async (t) => {
  await withCp(t, async (dir, seen) => {
    const args = (body) => [dir, body, 'A', ACTOR, true]
    await saveSettingsCp(
      ...args({
        expectedRevision: 0,
        gunBalance: { 'tacz:m4a1': { draw_time: 0.5 } },
        cpRevisions: {},
      }),
    )
    const saved = await saveSettingsCp(
      ...args({ expectedRevision: 1, gunBalance: {}, cpRevisions: { gunBalance: 1 } }),
    )
    assert.deepEqual(
      seen[seen.length - 1][1].patch,
      { overrides: null },
      'reset deletes the whole overrides dict',
    )
    assert.equal(saved.settings.revision, 2)
    assert.equal(saved.settings.gunBalance, undefined, 'view drops the reset dict')
    const after = await readSettingsCpView(dir)
    assert.equal(after.settings.gunBalance, undefined)
  })
})

test('CP view is rebuilt from CP: sequential section saves keep each other', async (t) => {
  await withCp(t, async (dir) => {
    await saveSettingsCp(
      dir,
      { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
      'A',
      ACTOR,
    )
    const view = await readSettingsCpView(dir)
    await saveSettingsCp(
      dir,
      {
        expectedRevision: view.settings.revision,
        lobby: { pvpEnabled: false },
        cpRevisions: { rooms: view.cpRevisions.rooms },
      },
      'B',
      ACTOR,
    )
    const after = await readSettingsCpView(dir)
    assert.deepEqual(after.settings.rooms, { maxRooms: 2 }, 'earlier section survives')
    assert.deepEqual(after.settings.lobby, { pvpEnabled: false }, 'later section lands')
    // Max semantics: rooms=1 and gameplay=1, so the max stays 1.
    assert.equal(after.settings.revision, 1)
  })
})

test('CP concurrent saves on disjoint sections both win without dropping', async (t) => {
  await withCp(t, async (dir) => {
    const [first, second] = await Promise.allSettled([
      saveSettingsCp(
        dir,
        { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
        'A',
        ACTOR,
      ),
      saveSettingsCp(
        dir,
        { expectedRevision: 0, lobby: { pvpEnabled: false }, cpRevisions: {} },
        'B',
        ACTOR,
      ),
    ])
    assert.equal(first.status, 'fulfilled', 'rooms save commits')
    assert.equal(second.status, 'fulfilled', 'disjoint lobby save commits too')
    const view = await readSettingsCpView(dir)
    assert.deepEqual(view.settings.rooms, { maxRooms: 2 }, 'no section dropped from the view')
    assert.deepEqual(view.settings.lobby, { pvpEnabled: false }, 'no section dropped from the view')
  })
})

test('CP 500 is unknown, not "not applied"', async (t) => {
  const { server } = fakeCp({ failPatch: 500 })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = temp(t)
  try {
    process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
    process.env.BLOCKFIELD_CP_SETTINGS_TOKEN = 'settings-t'
    process.env.BLOCKFIELD_CP_CONSUMER_ID = 'game'
    const error = await saveSettingsCp(
      dir,
      { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
      'A',
      ACTOR,
    ).then(
      () => assert.fail('expected an unknown-outcome failure'),
      (e) => e,
    )
    assert.equal(status(error), 503)
    const text = await error.text()
    assert.match(text, /Неизвестный итог/, 'unknown is reported, not success')
    assert.match(text, /перед повтором/, 'admin is told to reload before retrying')
    assert.doesNotMatch(
      text,
      /не изменены|не применено|Ничего не сохранено/,
      'never claims not-applied',
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
    delete process.env.BLOCKFIELD_CP_URL
    delete process.env.BLOCKFIELD_CP_SETTINGS_TOKEN
    delete process.env.BLOCKFIELD_CP_CONSUMER_ID
  }
})

test('CP rejects an unmapped lobby field with 422 and touches nothing', async (t) => {
  await withCp(t, async (dir, seen) => {
    await assert.rejects(
      saveSettingsCp(
        dir,
        {
          expectedRevision: 0,
          lobby: { pvpEnabled: true, pvpCooldownSeconds: 30 },
          cpRevisions: {},
        },
        'A',
        ACTOR,
      ),
      (e) => status(e) === 422,
    )
    assert.equal(seen.length, 0, 'no CP write on 422')
    const view = await readSettingsCpView(dir)
    assert.equal(view.settings.revision, 0, 'view untouched')
    assert.equal(view.settings.lobby, undefined, 'nothing lands')
  })
})

test('CP GET settings view carries per-namespace base revisions', async (t) => {
  await withCp(t, async (dir) => {
    await saveSettingsCp(
      dir,
      { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
      'A',
      ACTOR,
    )
    const view = await readSettingsCpView(dir)
    assert.deepEqual(view.cpRevisions, { rooms: 1 })
  })
})

test('CP classLocks-only save keeps stored classCosts (absent CP key)', async (t) => {
  await withCp(t, async (dir) => {
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 0,
        classLocks: ['tech'],
        classCosts: { tech: 5 },
        cpRevisions: {},
      },
      'A',
      ACTOR,
    )
    const view = await readSettingsCpView(dir)
    const saved = await saveSettingsCp(
      dir,
      {
        expectedRevision: view.settings.revision,
        classLocks: ['tech', 'sniper'],
        cpRevisions: { classLocks: view.cpRevisions.classLocks },
      },
      'A',
      ACTOR,
    )
    assert.equal(saved.settings.revision, 2)
    assert.deepEqual(saved.settings.classLocks, ['tech', 'sniper'])
    const after = await readSettingsCpView(dir)
    assert.deepEqual(after.settings.classLocks, ['tech', 'sniper'])
    assert.deepEqual(
      after.settings.classCosts,
      { tech: 5 },
      'the CP value has no classLocks change; the untouched classCosts survives in CP',
    )
  })
})

test('CP AI saves persist no transport metadata in the files', async (t) => {
  await withCp(t, async (dir) => {
    seed(dir, 'ai-limits.json', {
      schema: 1,
      revision: 0,
      currency: 'USD',
      mode: 'session',
      sessions: {},
      builders: {},
    })
    const policy = await saveAiLimitsCp(
      dir,
      { expectedRevision: 0, mode: 'builder', sessions: {}, builders: {} },
      'owner',
      ACTOR,
    )
    assert.equal(policy.policy.revision, 1)
    assert.deepEqual(policy.cpRevisions, { 'ai-limits': 1 }, 'UI still gets its base revision')
    assert.ok(!('cpRevisions' in policy.policy), 'response policy carries no transport key')
    const limitsFile = JSON.parse(readFileSync(join(dir, 'ai-limits.json')))
    assert.ok(!('cpRevisions' in limitsFile), 'ai-limits.json carries no transport key')
    seed(dir, 'workshop-ai-settings.json', {
      schema: 1,
      revision: 0,
      enabled: false,
      provider: 'openrouter',
      generationProvider: 'openrouter',
      guardProvider: 'openrouter',
      transcriptionProvider: 'openrouter',
      providers: [],
      generationModel: 'a/b',
      guardModel: 'typesafe/jev-1',
      transcriptionModel: 'openai/whisper-1',
      cleanupModel: '',
      cleanupProvider: 'openrouter',
      maxBlocks: 1024,
      blocksPerTick: 512,
      minimumBuildTicks: 60,
      applyBudgetMs: 4,
      hourlyRequestLimit: 100,
      hourlyPlayerRequestLimit: 10,
      maxHourlyBuilders: 32,
      generationMaxPricePromptUsdPerM: 0.5,
      generationMaxPriceCompletionUsdPerM: 1.5,
      inputGuardEnabled: false,
    })
    const workshop = await saveWorkshopAiSettingsCp(
      dir,
      {
        expectedRevision: 0,
        enabled: false,
        provider: 'openrouter',
        generationModel: 'a/b',
        guardModel: 'typesafe/jev-1',
        transcriptionModel: 'openai/whisper-1',
        maxBlocks: 1024,
        blocksPerTick: 512,
        minimumBuildTicks: 60,
        applyBudgetMs: 4,
        hourlyRequestLimit: 100,
        hourlyPlayerRequestLimit: 10,
        maxHourlyBuilders: 32,
        generationMaxPricePromptUsdPerM: 0.5,
        generationMaxPriceCompletionUsdPerM: 1.5,
        inputGuardEnabled: false,
      },
      () => true,
      ACTOR,
    )
    assert.ok(!('cpRevisions' in workshop.settings), 'response settings carry no transport key')
    const workshopFile = JSON.parse(readFileSync(join(dir, 'workshop-ai-settings.json')))
    assert.ok(!('cpRevisions' in workshopFile), 'workshop-ai-settings.json is clean')
  })
})

test('CP commit-then-timeout is treated as applied, not rejected', async (t) => {
  await withCp(
    t,
    async (dir) => {
      const saved = await saveSettingsCp(
        dir,
        { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
        'A',
        ACTOR,
      )
      assert.equal(saved.settings.revision, 1)
      assert.deepEqual(saved.settings.rooms, { maxRooms: 2 }, 'committed value is returned')
      const view = await readSettingsCpView(dir)
      assert.equal(view.settings.revision, 1)
      assert.deepEqual(view.settings.rooms, { maxRooms: 2 }, 'view reflects the committed value')
    },
    { commitThenHang: 'rooms' },
  )
})

test('CP campaignBalance: nested removal sends nested nulls, reset sends a parent null', async (t) => {
  await withCp(t, async (dir, seen) => {
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 0,
        campaignBalance: { '*': { max_tickets: 500 }, c1: { score_per_kill: 10 } },
        cpRevisions: {},
      },
      'A',
      ACTOR,
    )
    assert.deepEqual(seen[seen.length - 1][1].patch, {
      campaignBalance: { '*': { max_tickets: 500 }, c1: { score_per_kill: 10 } },
    })
    const view = await readSettingsCpView(dir)
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 1,
        campaignBalance: { '*': { max_tickets: 500 }, c1: {} },
        cpRevisions: { campaign: view.cpRevisions.campaign },
      },
      'A',
      ACTOR,
    )
    assert.deepEqual(
      seen[seen.length - 1][1].patch,
      { campaignBalance: { c1: { score_per_kill: null } } },
      'dropped field becomes a nested null; unchanged campaigns are absent',
    )
    const afterRemoval = await readSettingsCpView(dir)
    assert.deepEqual(afterRemoval.settings.campaignBalance, {
      '*': { max_tickets: 500 },
      c1: {},
    })
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 2,
        campaignBalance: {},
        cpRevisions: { campaign: afterRemoval.cpRevisions.campaign },
      },
      'A',
      ACTOR,
    )
    assert.deepEqual(
      seen[seen.length - 1][1].patch,
      { campaignBalance: null },
      'reset deletes the whole dict',
    )
    const afterReset = await readSettingsCpView(dir)
    assert.equal(afterReset.settings.campaignBalance, undefined)
    assert.equal(afterReset.settings.revision, 3)
    assert.ok(!('campaignBalance' in afterReset.settings), 'view drops the reset dict')
  })
})

test('CP gunBalance: dropping one gun sends a per-gun null, untouched guns are absent', async (t) => {
  await withCp(t, async (dir, seen) => {
    const args = (body) => [dir, body, 'A', ACTOR, true]
    await saveSettingsCp(
      ...args({
        expectedRevision: 0,
        gunBalance: { 'tacz:m4a1': { draw_time: 0.5 }, 'tacz:ak47': { draw_time: 0.6 } },
        cpRevisions: {},
      }),
    )
    const saved = await saveSettingsCp(
      ...args({
        expectedRevision: 1,
        gunBalance: { 'tacz:m4a1': { draw_time: 0.5 } },
        cpRevisions: { gunBalance: 1 },
      }),
    )
    assert.deepEqual(
      seen[seen.length - 1][1].patch,
      { overrides: { 'tacz:ak47': null } },
      'dropped gun becomes a null; the kept override is absent',
    )
    assert.deepEqual(saved.settings.gunBalance, { 'tacz:m4a1': { draw_time: 0.5 } })
  })
})

test('CP kits: dropped kit sends a null, cleared mode sends null as a value, other modes are never removals', async (t) => {
  await withCp(t, async (dir, seen) => {
    const catalog = kitFixture()
    const custom = { ...structuredClone(catalog.kits[0].effective), id: 'custom' }
    const view0 = await saveKitSettingsCp(
      dir,
      { expectedRevision: 0, kits: { custom }, fixedModeKits: { room: 'custom' }, cpRevisions: {} },
      'A',
      ACTOR,
    )
    assert.equal(view0.settings.revision, 1)
    assert.deepEqual(seen[seen.length - 1][1].patch, {
      kits: { custom },
      fixedModeKits: { room: 'custom' },
    })
    const dropped = await saveKitSettingsCp(
      dir,
      { expectedRevision: 1, kits: {}, fixedModeKits: { room: null }, cpRevisions: { kits: 1 } },
      'A',
      ACTOR,
    )
    assert.deepEqual(
      seen[seen.length - 1][1].patch,
      { kits: null, fixedModeKits: { room: null } },
      'dropped kit deletes via null; clearing a mode keeps null as the value',
    )
    assert.equal(dropped.settings.kits, undefined, 'view drops the deleted kits dict')
    assert.deepEqual(dropped.settings.fixedModeKits, { room: null })
    const patches = seen.length
    const kept = await saveKitSettingsCp(
      dir,
      { expectedRevision: 2, kits: {}, fixedModeKits: {}, cpRevisions: { kits: 2 } },
      'A',
      ACTOR,
    )
    assert.equal(seen.length, patches, 'a mode missing from fixedModeKits is not a removal')
    assert.deepEqual(kept.settings.fixedModeKits, { room: null }, 'stored null survives')
    assert.equal(kept.settings.revision, 2, 'no-op save keeps the revision')
  })
})

test('CP ai-limits: dropped account sends a nested null, reset scopes send parent nulls', async (t) => {
  const u1 = '11111111-1111-1111-1111-111111111111'
  const u2 = '22222222-2222-2222-2222-222222222222'
  const u3 = '33333333-3333-3333-3333-333333333333'
  await withCp(t, async (dir, seen) => {
    seed(dir, 'ai-limits.json', {
      schema: 1,
      revision: 0,
      currency: 'USD',
      mode: 'session',
      sessions: {},
      builders: {},
    })
    await saveAiLimitsCp(
      dir,
      { expectedRevision: 0, mode: 'session', sessions: { [u1]: 100, [u3]: 300 }, builders: {} },
      'owner',
      ACTOR,
    )
    assert.deepEqual(
      seen[seen.length - 1][1].patch,
      { mode: 'session', sessions: { [u1]: 100, [u3]: 300 } },
      'first init sets the mode; currency and empty builders are absent',
    )
    await saveAiLimitsCp(
      dir,
      {
        expectedRevision: 1,
        mode: 'session',
        sessions: { [u1]: 100 },
        builders: { [u2]: 50 },
        cpRevisions: { 'ai-limits': 1 },
      },
      'owner',
      ACTOR,
    )
    assert.deepEqual(
      seen[seen.length - 1][1].patch,
      { sessions: { [u3]: null }, builders: { [u2]: 50 } },
      'dropped account becomes a nested null',
    )
    await saveAiLimitsCp(
      dir,
      {
        expectedRevision: 2,
        mode: 'session',
        sessions: {},
        builders: { [u2]: 50 },
        cpRevisions: { 'ai-limits': 2 },
      },
      'owner',
      ACTOR,
    )
    assert.deepEqual(
      seen[seen.length - 1][1].patch,
      { sessions: null },
      'emptied scope deletes via a parent null; untouched builders are absent',
    )
    await saveAiLimitsCp(
      dir,
      {
        expectedRevision: 3,
        mode: 'session',
        sessions: {},
        builders: {},
        cpRevisions: { 'ai-limits': 3 },
      },
      'owner',
      ACTOR,
    )
    assert.deepEqual(seen[seen.length - 1][1].patch, { builders: null })
    const view = await readAiLimitsCpView(dir)
    assert.deepEqual(view.sessions ?? {}, {})
    assert.deepEqual(view.builders ?? {}, {})
  })
})

test('CP workshop-ai sequential saves survive the stamped mirror (tolerant reader)', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'workshop-ai-settings.json', {
      schema: 1,
      revision: 0,
      enabled: false,
      provider: 'openrouter',
      generationProvider: 'openrouter',
      guardProvider: 'openrouter',
      transcriptionProvider: 'openrouter',
      providers: [],
      generationModel: 'a/b',
      guardModel: 'typesafe/jev-1',
      transcriptionModel: 'openai/whisper-1',
      cleanupModel: '',
      cleanupProvider: 'openrouter',
      maxBlocks: 1024,
      blocksPerTick: 512,
      minimumBuildTicks: 60,
      applyBudgetMs: 4,
      hourlyRequestLimit: 100,
      hourlyPlayerRequestLimit: 10,
      maxHourlyBuilders: 32,
      generationMaxPricePromptUsdPerM: 0.5,
      generationMaxPriceCompletionUsdPerM: 1.5,
      inputGuardEnabled: false,
    })
    const base = {
      enabled: false,
      provider: 'openrouter',
      generationModel: 'a/b',
      guardModel: 'typesafe/jev-1',
      transcriptionModel: 'openai/whisper-1',
      maxBlocks: 1024,
      blocksPerTick: 512,
      minimumBuildTicks: 60,
      applyBudgetMs: 4,
      hourlyRequestLimit: 100,
      hourlyPlayerRequestLimit: 10,
      maxHourlyBuilders: 32,
      generationMaxPricePromptUsdPerM: 0.5,
      generationMaxPriceCompletionUsdPerM: 1.5,
      inputGuardEnabled: false,
    }
    const first = await saveWorkshopAiSettingsCp(
      dir,
      { expectedRevision: 0, ...base },
      () => true,
      ACTOR,
    )
    assert.equal(first.settings.revision, 1)
    const file1 = JSON.parse(readFileSync(join(dir, 'workshop-ai-settings.json')))
    assert.equal(file1.revision, 1)
    assert.equal(typeof file1.updatedAt, 'number', 'mirror carries stamps unlike ai-limits')
    // Second save proves the stamped file still reads: readWorkshopAiSettings
    // ignores unknown keys, so unlike ai-limits there is no 503 here.
    const second = await saveWorkshopAiSettingsCp(
      dir,
      { expectedRevision: 1, ...base, maxBlocks: 2048, cpRevisions: { 'workshop-ai': 1 } },
      () => true,
      ACTOR,
    )
    assert.equal(second.settings.revision, 2)
    assert.equal(second.settings.maxBlocks, 2048)
    assert.equal(seen[seen.length - 1][1].patch.maxBlocks, 2048)
    const file2 = JSON.parse(readFileSync(join(dir, 'workshop-ai-settings.json')))
    assert.equal(file2.revision, 2)
    assert.equal(file2.maxBlocks, 2048)
  })
})

test('CP streak table: saves without it keep it, null deletes the key in CP and the view', async (t) => {
  await withCp(t, async (dir, seen) => {
    const table = [{ kills: 4, id: 'minecraft:apple', count: 3, scale: false }]
    await saveSettingsCp(
      dir,
      { expectedRevision: 0, deathmatch: { streakRewards: table }, cpRevisions: {} },
      'A',
      ACTOR,
    )
    let view = await readSettingsCpView(dir)
    await saveSettingsCp(
      dir,
      {
        expectedRevision: view.settings.revision,
        rooms: { maxRooms: 3 },
        cpRevisions: { deathmatch: view.cpRevisions.deathmatch },
      },
      'A',
      ACTOR,
    )
    assert.deepEqual((await readSettingsCpView(dir)).settings.deathmatch.streakRewards, table)
    view = await readSettingsCpView(dir)
    await saveSettingsCp(
      dir,
      {
        expectedRevision: view.settings.revision,
        deathmatch: { minPlayers: 3 },
        cpRevisions: { deathmatch: view.cpRevisions.deathmatch },
      },
      'A',
      ACTOR,
    )
    assert.deepEqual((await readSettingsCpView(dir)).settings.deathmatch, {
      minPlayers: 3,
      streakRewards: table,
    })
    view = await readSettingsCpView(dir)
    await saveSettingsCp(
      dir,
      {
        expectedRevision: view.settings.revision,
        deathmatch: { minPlayers: 3, streakRewards: null },
        cpRevisions: { deathmatch: view.cpRevisions.deathmatch },
      },
      'A',
      ACTOR,
    )
    const patch = seen.filter(([ns]) => ns === 'deathmatch').at(-1)[1].patch
    assert.equal(patch.streakRewards, null, 'null is the RFC 7396 delete')
    assert.deepEqual((await readSettingsCpView(dir)).settings.deathmatch, { minPlayers: 3 })
  })
})

test('CP streak reset of a section holding only the table clears the view too', async (t) => {
  await withCp(t, async (dir) => {
    const table = [{ kills: 4, id: 'minecraft:apple', count: 3, scale: false }]
    await saveSettingsCp(
      dir,
      { expectedRevision: 0, deathmatch: { streakRewards: table }, cpRevisions: {} },
      'A',
      ACTOR,
    )
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 1,
        deathmatch: { streakRewards: null },
        cpRevisions: { deathmatch: 1 },
      },
      'A',
      ACTOR,
    )
    const view = await readSettingsCpView(dir)
    assert.equal(view.settings.deathmatch?.streakRewards, undefined)
    assert.equal(view.settings.deathmatch, undefined)
  })
})
