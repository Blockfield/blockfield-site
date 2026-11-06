import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveSettingsCp,
  saveMapAvailabilityCp,
  saveAiLimitsCp,
  readSettingsCpView,
} from '../src/lib/admin.ts'

const status = (error) =>
  error instanceof Response ? error.status : assert.fail(`expected Response, got ${error}`)
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-cp-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const seed = (dir, name, value) => writeFileSync(join(dir, name), JSON.stringify(value))

function merge(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch))
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
        ? merge(out[key], value)
        : value
  return out
}

/** Fake of the CP v2 settings contract on the feat/cp-settings-namespaces branch. */
function fakeCp() {
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
  const server = http.createServer((req, res) => {
    const answer = (code, data) => {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(data))
    }
    if (req.headers.authorization !== 'Bearer settings-t')
      return answer(401, { error: 'unauthenticated' })
    const match = req.url.match(/^\/v2\/settings\/([^/]+)\/([^/?]+)/)
    if (!match) return answer(404, { error: 'not_found' })
    const [, namespace, target] = match.map(decodeURIComponent)
    if (!known.has(namespace)) return answer(404, { error: 'unknown_namespace' })
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const key = `${namespace}/${target}`
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
      if (req.method !== 'PATCH') return answer(405, { error: 'method_not_allowed' })
      seen.push([namespace, JSON.parse(body)])
      const payload = JSON.parse(body)
      const current = state.get(key) ?? { revision: 0, value: {} }
      if (payload.expectedRevision !== current.revision)
        return answer(409, { error: 'revision_conflict' })
      const receipt = { operationId: `op-${seen.length}`, revision: current.revision + 1 }
      state.set(key, { revision: receipt.revision, value: merge(current.value, payload.patch) })
      return answer(202, receipt)
    })
  })
  return { server, seen }
}

async function withCp(t, fn) {
  const { server, seen } = fakeCp()
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
      saveSettingsCp(dir, body, 'B'),
    ])
    const won = [first, second].find((r) => r.status === 'fulfilled')
    const lost = [first, second].find((r) => r.status === 'rejected')
    assert.ok(won, 'one writer wins')
    assert.equal(won.value.revision, 1)
    assert.ok(lost, 'the other writer loses')
    assert.equal(lost.status, 'rejected')
    const reason = lost.status === 'rejected' ? lost.reason : assert.fail('unreachable')
    assert.equal(status(reason), 409)
    assert.match(await reason.text(), /уже изменил/)
    assert.equal(seen.filter(([ns]) => ns === 'rooms').length, 2)
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
    assert.equal(policy.revision, 1)
    assert.equal(policy.mode, 'builder')
    assert.equal(seen.length, 1)
    assert.equal(seen[0][0], 'ai-limits')
    assert.deepEqual(seen[0][1].patch, {
      currency: 'USD',
      mode: 'builder',
      sessions: {},
      builders: {},
    })
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
    assert.deepEqual(saved.disabledMapIds, ['arena1'])
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
    assert.deepEqual(view.settings.lobby, { pvpEnabled: true })
    assert.deepEqual(view.settings.rooms, { maxRooms: 2 })
  })
})
