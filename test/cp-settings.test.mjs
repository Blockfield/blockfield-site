import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readSettingsCp, patchSettingsCp, isRevisionConflict } from '../src/lib/cp.ts'

function json(res, status, data) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

/** Minimal fake of the frozen v2 settings contract (gameplay + gate only). */
function fakeSettingsCp() {
  const namespaces = {
    gameplay: { lobby: { pvpEnabled: false }, match: { maxPlayers: 32, respawnSeconds: 5 } },
    gate: { mode: 'open', message: '' },
  }
  const state = {
    'gameplay/*': { revision: 7, value: structuredClone(namespaces.gameplay) },
  }
  const ops = new Map()
  let counter = 0
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer settings-t')
      return json(res, 401, { error: 'unauthenticated' })
    const match = req.url.match(/^\/v2\/settings\/([^/]+)\/([^/?]+)/)
    if (!match) return json(res, 404, { error: 'not_found' })
    const [, namespace, target] = match.map(decodeURIComponent)
    if (!Object.hasOwn(namespaces, namespace)) return json(res, 404, { error: 'unknown_namespace' })
    const key = `${namespace}/${target}`
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.method === 'GET') {
        const current = state[key] ?? { revision: 0, value: namespaces[namespace] }
        return json(res, 200, {
          initialized: true,
          revision: current.revision,
          value: current.value,
          hash: 'deadbeef',
          application: 'see operation receipts',
        })
      }
      if (req.method !== 'PATCH') return json(res, 405, { error: 'method_not_allowed' })
      const payload = JSON.parse(body)
      if (ops.has(payload.idempotencyKey)) {
        const prev = ops.get(payload.idempotencyKey)
        if (prev.body === body) return json(res, 202, prev.receipt)
        return json(res, 409, { error: 'idempotency_conflict' })
      }
      const current = state[key] ?? { revision: 0, value: namespaces[namespace] }
      if (payload.expectedRevision !== current.revision)
        return json(res, 409, { error: 'revision_conflict' })
      const receipt = { operationId: `op-${++counter}`, revision: current.revision + 1 }
      state[key] = {
        revision: receipt.revision,
        value: { ...current.value, ...payload.patch },
      }
      ops.set(payload.idempotencyKey, { body, receipt })
      return json(res, 202, receipt)
    })
  })
  return { server, state }
}

async function withServer(fn) {
  const { server } = fakeSettingsCp()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
    process.env.BLOCKFIELD_CP_SETTINGS_TOKEN = 'settings-t'
    await fn(server)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    delete process.env.BLOCKFIELD_CP_URL
    delete process.env.BLOCKFIELD_CP_SETTINGS_TOKEN
  }
}

test('CP settings round-trip: GET then PATCH with expectedRevision + idempotency', async () => {
  await withServer(async () => {
    const before = await readSettingsCp('gameplay')
    assert.equal(before.revision, 7)
    const out = await patchSettingsCp('gameplay', '*', {
      expectedRevision: before.revision,
      idempotencyKey: 'site-settings-1',
      patch: { lobby: { pvpEnabled: true } },
    })
    assert.match(out.operationId, /^op-/)
    assert.equal(out.revision, 8)
    const after = await readSettingsCp('gameplay')
    assert.equal(after.revision, 8)
    assert.deepEqual(after.value.lobby, { pvpEnabled: true })
  })
})

test('CP settings CAS conflict: stale expectedRevision fails closed with revision_conflict', async () => {
  await withServer(async () => {
    const before = await readSettingsCp('gameplay')
    await patchSettingsCp('gameplay', '*', {
      expectedRevision: before.revision,
      idempotencyKey: 'site-settings-winner',
      patch: { match: { maxPlayers: 24, respawnSeconds: 5 } },
    })
    await assert.rejects(
      patchSettingsCp('gameplay', '*', {
        expectedRevision: before.revision,
        idempotencyKey: 'site-settings-loser',
        patch: { match: { maxPlayers: 16, respawnSeconds: 5 } },
      }),
      (error) => {
        assert.equal(isRevisionConflict(error), true)
        assert.match(error.message, /уже изменил/)
        return true
      },
    )
  })
})

test('CP settings idempotent retry: same key + same body returns the same operation', async () => {
  await withServer(async () => {
    const before = await readSettingsCp('gameplay')
    const args = {
      expectedRevision: before.revision,
      idempotencyKey: 'site-settings-retry',
      patch: { lobby: { pvpEnabled: true } },
    }
    const first = await patchSettingsCp('gameplay', '*', args)
    const second = await patchSettingsCp('gameplay', '*', args)
    assert.deepEqual(second, first)
  })
})

test('CP settings fail closed: unconfigured URL and dead server both throw', async () => {
  delete process.env.BLOCKFIELD_CP_URL
  await assert.rejects(readSettingsCp('gameplay'), /не настроен/)
  process.env.BLOCKFIELD_CP_URL = 'http://127.0.0.1:9'
  process.env.BLOCKFIELD_CP_SETTINGS_TOKEN = 'settings-t'
  await assert.rejects(
    patchSettingsCp('gameplay', '*', {
      expectedRevision: 0,
      idempotencyKey: 'k',
      patch: {},
    }),
  )
  delete process.env.BLOCKFIELD_CP_URL
  delete process.env.BLOCKFIELD_CP_SETTINGS_TOKEN
})

test('CP settings rejects unknown namespace and unsafe path segments locally', async () => {
  await withServer(async (server) => {
    const seen = []
    const origEmit = server.emit.bind(server)
    server.emit = (event, ...args) => {
      if (event === 'request') seen.push(args[0]?.url)
      return origEmit(event, ...args)
    }
    await assert.rejects(readSettingsCp('kits'), (error) => isRevisionConflict(error) === false)
    await assert.rejects(readSettingsCp('../etc'), /Некорректный/)
    await assert.rejects(
      patchSettingsCp('gameplay', 'a/b', {
        expectedRevision: 0,
        idempotencyKey: 'k',
        patch: {},
      }),
      /Некорректный/,
    )
    assert.ok(seen.every((url) => !url.includes('..') && !url.includes('a/b')))
  })
})
