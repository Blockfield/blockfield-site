import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
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
} from '../src/lib/admin.ts'
import { kitFixture } from './kits-fixture.mjs'

const status = (error) =>
  error instanceof Response ? error.status : assert.fail(`expected Response, got ${error}`)
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-cp-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const seed = (dir, name, value) => writeFileSync(join(dir, name), JSON.stringify(value))

/**
 * Merge with the exact semantics of control-plane main post-#25
 * (cpv2/settings.py `merge`, RFC 7396 JSON Merge Patch): a patch null
 * deletes the key recursively before validation, absent keys are untouched,
 * arrays are replaced wholesale. The only stored-null exception is
 * `fixedModeKits.<mode>` ("kit id or null"): null clears the fixed kit but
 * keeps the explicit entry.
 */
const NULL_VALUED_PARENTS = new Set(['fixedModeKits'])
function merge(base, patch, parent) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && !NULL_VALUED_PARENTS.has(parent)) delete out[key]
    else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    )
      out[key] = merge(out[key], value, key)
    else out[key] = value
  }
  return out
}

/**
 * Narrow mirror of the cpv2/settings.py Strict validators that matter here
 * (control-plane main post-#25): gameplay.lobby allows only pvpEnabled;
 * gunBalance, kits and campaign values must be objects — a patch null
 * deletes before validation, so it never reaches the models; fixedModeKits
 * values are kit ids or null (the stored-null exception); ai-limits scopes
 * hold micros or are absent after a null-delete reset.
 */
function validateNs(namespace, value) {
  if (namespace === 'gameplay') {
    for (const key of Object.keys(value.lobby ?? {}))
      if (key !== 'pvpEnabled') return `gameplay.lobby: unknown key ${key}`
  }
  if (namespace === 'gunBalance') {
    for (const [id, override] of Object.entries(value.overrides ?? {}))
      if (!override || typeof override !== 'object' || Array.isArray(override))
        return `gunBalance.${id}: expected override object`
  }
  if (namespace === 'kits') {
    for (const [id, kit] of Object.entries(value.kits ?? {}))
      if (!kit || typeof kit !== 'object') return `kits.${id}: expected object`
    for (const [mode, target] of Object.entries(value.fixedModeKits ?? {}))
      if (target !== null && typeof target !== 'string')
        return `fixedModeKits.${mode}: expected kit id or null`
  }
  if (namespace === 'campaign') {
    for (const [id, balance] of Object.entries(value.campaignBalance ?? {}))
      if (!balance || typeof balance !== 'object' || Array.isArray(balance))
        return `campaignBalance.${id}: expected object`
  }
  if (namespace === 'ai-limits') {
    for (const scope of ['sessions', 'builders']) {
      const accounts = value[scope]
      if (accounts === undefined) continue
      if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts))
        return `ai-limits.${scope}: expected object`
      for (const [, amount] of Object.entries(accounts))
        if (!Number.isSafeInteger(amount)) return `ai-limits.${scope}: expected micros`
    }
  }
  return null
}

/** Fake of the CP v2 settings contract on control-plane main (post-#21). */
function fakeCp(opts = {}) {
  const known = new Set([
    'gameplay',
    'rooms',
    'deathmatch',
    'classLocks',
    'campaign',
    'parcool',
    'gunBalance',
    'kits',
    'disabledMapIds',
    'ai-limits',
    'workshop-ai',
  ])
  const state = new Map()
  const seen = []
  const idem = new Map()
  const server = http.createServer((req, res) => {
    const answer = (code, data) => {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(data))
    }
    if (req.headers.authorization !== 'Bearer settings-t')
      return answer(401, { error: 'unauthenticated' })
    const match = req.url.match(/^\/v2\/settings\/([^/]+)\/([^/?]+)(\/rollback)?/)
    if (!match) return answer(404, { error: 'not_found' })
    const [, namespace, target, rollback] = match.map((s) => (s ? decodeURIComponent(s) : s))
    if (!known.has(namespace)) return answer(404, { error: 'unknown_namespace' })
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const key = `${namespace}/${target}`
      const payload = body ? JSON.parse(body) : {}
      if (req.method === 'GET') {
        const current = state.get(key)
        if (!current)
          return answer(200, { initialized: false, revision: 0, value: {}, hash: 'none' })
        return answer(200, {
          initialized: true,
          revision: current.revision,
          value: current.value,
          hash: 'hash',
        })
      }
      seen.push([namespace, payload])
      if (opts.failPatch === 500 && !rollback) return answer(500, { error: 'internal' })
      const idemKey = `${key}/${payload.idempotencyKey ?? ''}`
      if (req.method === 'PATCH' || (req.method === 'POST' && rollback)) {
        if (payload.patch && payload.patch.$fail === '500')
          return answer(500, { error: 'internal' })
        if (payload.patch && payload.patch.$fail === 'timeout') {
          req.socket.destroy()
          return
        }
        const current = state.get(key) ?? { revision: 0, value: {}, history: [] }
        if (idem.has(idemKey)) {
          const prev = idem.get(idemKey)
          if (JSON.stringify(prev.body) === body) return answer(202, prev.receipt)
          return answer(409, { error: 'idempotency_conflict' })
        }
        if (payload.expectedRevision !== current.revision)
          return answer(409, { error: 'revision_conflict' })
        let candidate
        if (rollback) {
          candidate = current.history[payload.revision - 1]
          if (candidate === undefined) return answer(404, { error: 'revision_not_found' })
          candidate = JSON.parse(JSON.stringify(candidate))
        } else {
          candidate = merge(current.value, payload.patch)
          const invalid = validateNs(namespace, candidate)
          if (invalid) return answer(422, { error: 'invalid_settings', detail: invalid })
        }
        const receipt = { operationId: `op-${seen.length}`, revision: current.revision + 1 }
        idem.set(idemKey, { body, receipt })
        state.set(key, {
          revision: receipt.revision,
          value: candidate,
          history: [...current.history, JSON.parse(JSON.stringify(candidate))],
        })
        if (opts.commitThenHang === namespace) {
          opts.commitThenHang = ''
          req.socket.destroy()
          return
        }
        return answer(202, receipt)
      }
      return answer(405, { error: 'method_not_allowed' })
    })
  })
  return { server, seen }
}

async function withCp(t, fn, opts = {}) {
  const { server, seen } = fakeCp(opts)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = temp(t)
  try {
    process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
    process.env.BLOCKFIELD_CP_SETTINGS_TOKEN = 'settings-t'
    await fn(dir, seen)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    delete process.env.BLOCKFIELD_CP_URL
    delete process.env.BLOCKFIELD_CP_SETTINGS_TOKEN
  }
}

test('CP settings CAS on a real handler: concurrent writers, one wins with 409', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    const body = { expectedRevision: 0, rooms: { maxRooms: 2 } }
    const [first, second] = await Promise.allSettled([
      saveSettingsCp(dir, body, 'A'),
      saveSettingsCp(dir, { expectedRevision: 0, rooms: { maxRooms: 3 } }, 'B'),
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
    assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'))).revision, 1)
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
    await assert.rejects(saveAiLimitsCp(dir, body, 'admin'), (e) => status(e) === 403)
    assert.equal(seen.length, 0)
    const policy = await saveAiLimitsCp(dir, body, 'owner')
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
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    const saved = await saveMapAvailabilityCp(
      dir,
      { mapId: 'arena1', enabled: false, expectedRevision: 0 },
      'A',
    )
    assert.deepEqual(saved.settings.disabledMapIds, ['arena1'])
    const view = await readSettingsCpView(dir)
    assert.deepEqual(view.settings.disabledMapIds, ['arena1'])
    assert.equal(view.settings.revision, 1)
  })
})

test('CP GET view overlays CP namespaces on the file mirror', async (t) => {
  await withCp(t, async (dir) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0, lobby: { pvpCooldownSeconds: 30 } })
    await saveSettingsCp(
      dir,
      { expectedRevision: 0, lobby: { pvpEnabled: true }, rooms: { maxRooms: 2 } },
      'A',
    )
    const view = await readSettingsCpView(dir)
    assert.deepEqual(view.settings.lobby, { pvpCooldownSeconds: 30, pvpEnabled: true })
    assert.deepEqual(view.settings.rooms, { maxRooms: 2 })
  })
})
test('CP settings requires the carried base revision: missing base is a 409', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    const first = await saveSettingsCp(
      dir,
      { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
      'A',
    )
    assert.equal(first.settings.revision, 1)
    await assert.rejects(
      saveSettingsCp(dir, { expectedRevision: 1, rooms: { maxRooms: 3 } }, 'B'),
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
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    await saveSettingsCp(dir, { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} }, 'A')
    await assert.rejects(
      saveSettingsCp(
        dir,
        { expectedRevision: 1, rooms: { maxRooms: 3 }, cpRevisions: { rooms: 0 } },
        'B',
      ),
      (e) => status(e) === 409,
    )
  })
})

test('CP settings PATCHes only changed namespaces', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 0,
        lobby: { pvpEnabled: true },
        rooms: { maxRooms: 2 },
        cpRevisions: {},
      },
      'A',
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
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 0,
        lobby: { pvpEnabled: true },
        rooms: { maxRooms: 2 },
        cpRevisions: {},
      },
      'A',
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
    ).then(
      () => assert.fail('expected a partial-commit failure'),
      (e) => e,
    )
    assert.equal(status(error), 409)
    const text = await error.text()
    assert.match(text, /lobby/, 'names the committed section')
    assert.match(text, /rooms/, 'names the failed section')
    const mirror = JSON.parse(readFileSync(join(dir, 'settings.json')))
    assert.deepEqual(mirror.lobby, { pvpEnabled: false }, 'committed section mirrored')
    assert.deepEqual(mirror.rooms, { maxRooms: 2 }, 'failed section keeps the old mirror')
  })
})

test('CP gun-only path PATCHes only gunBalance', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'settings.json', {
      schema: 1,
      revision: 0,
      lobby: { pvpEnabled: true },
      rooms: { maxRooms: 2 },
    })
    seed(dir, 'gun-balance.json', {
      schema: 1,
      revision: 0,
      fields: {
        type: 'object',
        nullable: false,
        fields: { draw_time: { type: 'number', nullable: false, min: 0, max: 60 } },
      },
      guns: [
        {
          id: 'tacz:m4a1',
          data: 'tacz:m4a1',
          name: 'gun',
          type: 'rifle',
          defaults: { draw_time: 0.32 },
          effective: { draw_time: 0.32 },
          warnings: [],
        },
      ],
    })
    const saved = await saveSettingsCp(
      dir,
      {
        expectedRevision: 0,
        gunBalance: { 'tacz:m4a1': { draw_time: 0.5 } },
        cpRevisions: {},
      },
      'A',
      true,
    )
    assert.equal(saved.settings.revision, 1)
    assert.deepEqual(
      seen.map(([ns]) => ns),
      ['gunBalance'],
      'gun-only save touches no other namespace (single PATCH, no anchor revision)',
    )
    const mirror = JSON.parse(readFileSync(join(dir, 'settings.json')))
    assert.deepEqual(mirror.gunBalance, { 'tacz:m4a1': { draw_time: 0.5 } })
    assert.deepEqual(mirror.lobby, { pvpEnabled: true }, 'mirror keeps untouched sections')
  })
})

test('CP reset-all gun overrides sends a null-delete PATCH', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    seed(dir, 'gun-balance.json', {
      schema: 1,
      revision: 0,
      fields: {
        type: 'object',
        nullable: false,
        fields: { draw_time: { type: 'number', nullable: false, min: 0, max: 60 } },
      },
      guns: [
        {
          id: 'tacz:m4a1',
          data: 'tacz:m4a1',
          name: 'gun',
          type: 'rifle',
          defaults: { draw_time: 0.32 },
          effective: { draw_time: 0.32 },
          warnings: [],
        },
      ],
    })
    const args = (body) => [dir, body, 'A', true]
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
    assert.equal(saved.settings.gunBalance, undefined, 'mirror drops the reset dict')
    const mirror = JSON.parse(readFileSync(join(dir, 'settings.json')))
    assert.equal(mirror.revision, 2)
    assert.ok(!('gunBalance' in mirror), 'mirror file drops the reset dict')
    const after = await readSettingsCpView(dir)
    assert.equal(after.settings.gunBalance, undefined)
  })
})

test('CP mirror is rebuilt from CP: sequential section saves keep each other', async (t) => {
  await withCp(t, async (dir) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    await saveSettingsCp(dir, { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} }, 'A')
    const view = await readSettingsCpView(dir)
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 1,
        lobby: { pvpEnabled: false },
        cpRevisions: { rooms: view.cpRevisions.rooms },
      },
      'B',
    )
    const mirror = JSON.parse(readFileSync(join(dir, 'settings.json')))
    assert.deepEqual(mirror.rooms, { maxRooms: 2 }, 'earlier section survives')
    assert.deepEqual(mirror.lobby, { pvpEnabled: false }, 'later section lands')
    assert.equal(mirror.revision, 2)
  })
})

test('CP concurrent saves on disjoint sections both win without dropping', async (t) => {
  await withCp(t, async (dir) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    const [first, second] = await Promise.allSettled([
      saveSettingsCp(dir, { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} }, 'A'),
      saveSettingsCp(
        dir,
        { expectedRevision: 0, lobby: { pvpEnabled: false }, cpRevisions: {} },
        'B',
      ),
    ])
    assert.equal(first.status, 'fulfilled', 'rooms save commits')
    assert.equal(second.status, 'fulfilled', 'disjoint lobby save commits too')
    const mirror = JSON.parse(readFileSync(join(dir, 'settings.json')))
    assert.deepEqual(mirror.rooms, { maxRooms: 2 }, 'no section dropped from the mirror')
    assert.deepEqual(mirror.lobby, { pvpEnabled: false }, 'no section dropped from the mirror')
  })
})

test('CP 500 is unknown, not "not applied"', async (t) => {
  const { server } = fakeCp({ failPatch: 500 })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = temp(t)
  try {
    process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
    process.env.BLOCKFIELD_CP_SETTINGS_TOKEN = 'settings-t'
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    const error = await saveSettingsCp(
      dir,
      { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
      'A',
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
  }
})

test('CP rejects an unmapped lobby field with 422 and touches nothing', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    await assert.rejects(
      saveSettingsCp(
        dir,
        {
          expectedRevision: 0,
          lobby: { pvpEnabled: true, pvpCooldownSeconds: 30 },
          cpRevisions: {},
        },
        'A',
      ),
      (e) => status(e) === 422,
    )
    assert.equal(seen.length, 0, 'no CP write on 422')
    const mirror = JSON.parse(readFileSync(join(dir, 'settings.json')))
    assert.equal(mirror.revision, 0, 'mirror untouched')
    assert.equal(mirror.lobby, undefined, 'nothing mirrored')
  })
})

test('CP GET settings view carries per-namespace base revisions', async (t) => {
  await withCp(t, async (dir) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    await saveSettingsCp(dir, { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} }, 'A')
    const view = await readSettingsCpView(dir)
    assert.deepEqual(view.cpRevisions, { rooms: 1 })
  })
})

test('CP classLocks-only save keeps stored classCosts (absent CP key)', async (t) => {
  await withCp(t, async (dir) => {
    seed(dir, 'settings.json', {
      schema: 1,
      revision: 0,
      classLocks: ['tech'],
      classCosts: { tech: 5 },
    })
    const saved = await saveSettingsCp(
      dir,
      { expectedRevision: 0, classLocks: ['tech', 'sniper'], cpRevisions: {} },
      'A',
    )
    assert.equal(saved.settings.revision, 1)
    assert.deepEqual(saved.settings.classLocks, ['tech', 'sniper'])
    const view = await readSettingsCpView(dir)
    assert.deepEqual(view.settings.classLocks, ['tech', 'sniper'])
    assert.deepEqual(
      view.settings.classCosts,
      { tech: 5 },
      'the CP value has no classCosts; the mirror value survives',
    )
    const mirror = JSON.parse(readFileSync(join(dir, 'settings.json')))
    assert.deepEqual(mirror.classCosts, { tech: 5 }, 'mirror keeps the stored costs')
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
      seed(dir, 'settings.json', { schema: 1, revision: 0 })
      const saved = await saveSettingsCp(
        dir,
        { expectedRevision: 0, rooms: { maxRooms: 2 }, cpRevisions: {} },
        'A',
      )
      assert.equal(saved.settings.revision, 1)
      assert.deepEqual(saved.settings.rooms, { maxRooms: 2 }, 'committed value is returned')
      const mirror = JSON.parse(readFileSync(join(dir, 'settings.json')))
      assert.equal(mirror.revision, 1)
      assert.deepEqual(mirror.rooms, { maxRooms: 2 }, 'mirror reflects the committed value')
    },
    { commitThenHang: 'rooms' },
  )
})

test('CP campaignBalance: nested removal sends nested nulls, reset sends a parent null', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 0,
        campaignBalance: { '*': { max_tickets: 500 }, c1: { score_per_kill: 10 } },
        cpRevisions: {},
      },
      'A',
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
    )
    assert.deepEqual(
      seen[seen.length - 1][1].patch,
      { campaignBalance: null },
      'reset deletes the whole dict',
    )
    const afterReset = await readSettingsCpView(dir)
    assert.equal(afterReset.settings.campaignBalance, undefined)
    const mirror = JSON.parse(readFileSync(join(dir, 'settings.json')))
    assert.equal(mirror.revision, 3)
    assert.ok(!('campaignBalance' in mirror), 'mirror file drops the reset dict')
  })
})

test('CP gunBalance: dropping one gun sends a per-gun null, untouched guns are absent', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    seed(dir, 'gun-balance.json', {
      schema: 1,
      revision: 0,
      fields: {
        type: 'object',
        nullable: false,
        fields: { draw_time: { type: 'number', nullable: false, min: 0, max: 60 } },
      },
      guns: ['tacz:m4a1', 'tacz:ak47'].map((id) => ({
        id,
        data: id,
        name: 'gun',
        type: 'rifle',
        defaults: { draw_time: 0.32 },
        effective: { draw_time: 0.32 },
        warnings: [],
      })),
    })
    const args = (body) => [dir, body, 'A', true]
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
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    seed(dir, 'kits.json', kitFixture())
    const catalog = kitFixture()
    const custom = { ...structuredClone(catalog.kits[0].effective), id: 'custom' }
    const view0 = await saveKitSettingsCp(
      dir,
      { expectedRevision: 0, kits: { custom }, fixedModeKits: { room: 'custom' }, cpRevisions: {} },
      'A',
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
    )
    assert.deepEqual(
      seen[seen.length - 1][1].patch,
      { kits: null, fixedModeKits: { room: null } },
      'dropped kit deletes via null; clearing a mode keeps null as the value',
    )
    assert.equal(dropped.settings.kits, undefined, 'mirror drops the deleted kits dict')
    assert.deepEqual(dropped.settings.fixedModeKits, { room: null })
    const patches = seen.length
    const kept = await saveKitSettingsCp(
      dir,
      { expectedRevision: 2, kits: {}, fixedModeKits: {}, cpRevisions: { kits: 2 } },
      'A',
    )
    assert.equal(seen.length, patches, 'a mode missing from fixedModeKits is not a removal')
    assert.deepEqual(kept.settings.fixedModeKits, { room: null }, 'stored null survives')
    assert.equal(kept.settings.revision, 3, 'no-op save still stamps the mirror')
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
    const first = await saveWorkshopAiSettingsCp(dir, { expectedRevision: 0, ...base }, () => true)
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
    )
    assert.equal(second.settings.revision, 2)
    assert.equal(second.settings.maxBlocks, 2048)
    assert.equal(seen[seen.length - 1][1].patch.maxBlocks, 2048)
    const file2 = JSON.parse(readFileSync(join(dir, 'workshop-ai-settings.json')))
    assert.equal(file2.revision, 2)
    assert.equal(file2.maxBlocks, 2048)
  })
})

test('CP streak table: saves without it keep it, null deletes the key in CP and the mirror', async (t) => {
  await withCp(t, async (dir, seen) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    const table = [{ kills: 4, id: 'minecraft:apple', count: 3, scale: false }]
    const mirror = () => JSON.parse(readFileSync(join(dir, 'settings.json')))
    await saveSettingsCp(
      dir,
      { expectedRevision: 0, deathmatch: { streakRewards: table }, cpRevisions: {} },
      'A',
    )
    await saveSettingsCp(dir, { expectedRevision: 1, rooms: { maxRooms: 3 }, cpRevisions: {} }, 'A')
    assert.deepEqual((await readSettingsCpView(dir)).settings.deathmatch.streakRewards, table)
    await saveSettingsCp(
      dir,
      { expectedRevision: 2, deathmatch: { minPlayers: 3 }, cpRevisions: { deathmatch: 1 } },
      'A',
    )
    assert.deepEqual(mirror().deathmatch, { minPlayers: 3, streakRewards: table })
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 3,
        deathmatch: { minPlayers: 3, streakRewards: null },
        cpRevisions: { deathmatch: 2 },
      },
      'A',
    )
    const patch = seen.filter(([ns]) => ns === 'deathmatch').at(-1)[1].patch
    assert.equal(patch.streakRewards, null, 'null is the RFC 7396 delete')
    assert.deepEqual((await readSettingsCpView(dir)).settings.deathmatch, { minPlayers: 3 })
    assert.deepEqual(mirror().deathmatch, { minPlayers: 3 })
  })
})

test('CP streak reset of a section holding only the table clears the mirror too', async (t) => {
  await withCp(t, async (dir) => {
    seed(dir, 'settings.json', { schema: 1, revision: 0 })
    const table = [{ kills: 4, id: 'minecraft:apple', count: 3, scale: false }]
    await saveSettingsCp(
      dir,
      { expectedRevision: 0, deathmatch: { streakRewards: table }, cpRevisions: {} },
      'A',
    )
    await saveSettingsCp(
      dir,
      {
        expectedRevision: 1,
        deathmatch: { streakRewards: null },
        cpRevisions: { deathmatch: 1 },
      },
      'A',
    )
    const view = await readSettingsCpView(dir)
    assert.equal(view.settings.deathmatch?.streakRewards, undefined)
    const stored = JSON.parse(readFileSync(join(dir, 'settings.json')))
    assert.equal(stored.deathmatch?.streakRewards, undefined)
    assert.doesNotMatch(JSON.stringify(stored), /null/)
  })
})
