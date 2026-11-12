import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  maintenanceFromCp,
  readGateCp,
  postGateCp,
  gateToggle,
  cpConfigured,
} from '../src/lib/cp.ts'
import { maintenanceFrom } from '../src/lib/rooms.ts'

test('CP maintenance closes entry, other modes keep it open', () => {
  const base = { revision: 3, since: 7, observedAt: Date.now() }
  assert.deepEqual(maintenanceFromCp({ ...base, mode: 'maintenance', message: 'Техработы' }), {
    message: 'Техработы',
    since: 7,
  })
  assert.equal(maintenanceFromCp({ ...base, mode: 'open', message: '' }), null)
  assert.equal(maintenanceFromCp({ ...base, mode: 'draining', message: '' }), null)
  // same default message path as the host gate file
  assert.equal(
    maintenanceFromCp({ ...base, mode: 'maintenance', message: '' })?.message,
    maintenanceFrom({ mode: 'maintenance' })?.message,
  )
})

test('CP buttons flag follows BLOCKFIELD_CP_URL (fail-before: no such flag)', () => {
  delete process.env.BLOCKFIELD_CP_URL
  assert.equal(cpConfigured(), false)
  assert.equal(cpConfigured({ BLOCKFIELD_CP_URL: '   ' }), false)
  assert.equal(cpConfigured({ BLOCKFIELD_CP_URL: 'http://127.0.0.1:9' }), true)
  process.env.BLOCKFIELD_CP_URL = 'http://127.0.0.1:9/'
  assert.equal(cpConfigured(), true)
  delete process.env.BLOCKFIELD_CP_URL
})

test('gate toggle accepts only the two maintenance actions', () => {
  assert.deepEqual(gateToggle({ action: 'maintenance-start' }), {
    mode: 'maintenance',
    message: '',
  })
  assert.deepEqual(gateToggle({ action: 'maintenance-stop' }), { mode: 'open', message: '' })
  assert.throws(() => gateToggle({ action: 'drain' }))
  assert.throws(() => gateToggle({}))
})

async function fakeCp(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

test('CP client toggles the gate with one POST /v2/gate/toggle call', async () => {
  let state = { revision: 4, mode: 'open' }
  const seen = []
  const server = await fakeCp((req, res) => {
    seen.push([req.method, req.url, req.headers.authorization])
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'GET' && req.url === '/v1/gate')
        return res.end(
          JSON.stringify({
            schema: 1,
            revision: state.revision,
            mode: state.mode,
            message: '',
            since: 1,
            observedAt: 2,
          }),
        )
      if (req.method === 'POST' && req.url === '/v2/gate/toggle') {
        const payload = JSON.parse(body)
        assert.match(payload.idempotencyKey, /.+/)
        assert.equal(payload.environment, 'prod')
        assert.equal(payload.backend, 'game')
        assert.equal(payload.mode, 'maintenance')
        assert.equal(payload.message, '')
        assert.ok(!('expectedRevision' in payload), 'no client-side revision read')
        assert.ok(!('patch' in payload), 'no patch envelope')
        state = { ...state, revision: state.revision + 1, mode: payload.mode }
        res.statusCode = 202
        return res.end(JSON.stringify({ operationId: 'op1', revision: state.revision }))
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not_found' }))
    })
  })
  try {
    Object.assign(process.env, {
      BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
      BLOCKFIELD_CP_GATE_READ_TOKEN: 'read-t',
      BLOCKFIELD_CP_GATE_TOKEN: 'gate-t',
    })
    assert.equal(await readGateCp(), null)
    const out = await postGateCp('maintenance', '', 'k1')
    assert.equal(out.operationId, 'op1')
    assert.equal(out.revision, 5)
    const closed = await readGateCp()
    assert.equal(
      closed?.message,
      'На сервере проводятся технические работы. Обычный вход временно недоступен.',
    )
    // One write round-trip: no GET /v1/gate + PATCH pair around the toggle.
    assert.deepEqual(
      seen.map(([m, u]) => [m, u]),
      [
        ['GET', '/v1/gate'],
        ['POST', '/v2/gate/toggle'],
        ['GET', '/v1/gate'],
      ],
    )
    assert.deepEqual(
      seen.map(([, , auth]) => auth),
      ['Bearer read-t', 'Bearer gate-t', 'Bearer read-t'],
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
    delete process.env.BLOCKFIELD_CP_URL
  }
})

test('CP gate toggle surfaces clear admin errors with status', async () => {
  const server = await fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      const key = JSON.parse(body).idempotencyKey
      if (key === 'k-noaccess') {
        res.statusCode = 403
        return res.end(JSON.stringify({ error: 'forbidden' }))
      }
      res.statusCode = 409
      res.end(JSON.stringify({ error: 'idempotency_conflict' }))
    })
  })
  try {
    Object.assign(process.env, {
      BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
      BLOCKFIELD_CP_GATE_TOKEN: 'gate-t',
    })
    await assert.rejects(postGateCp('maintenance', '', 'k-busy'), (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'idempotency_conflict')
      assert.match(error.message, /уже обрабатывается/)
      return true
    })
    await assert.rejects(postGateCp('maintenance', '', 'k-noaccess'), (error) => {
      assert.equal(error.status, 403)
      assert.match(error.message, /нет доступа/)
      return true
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    delete process.env.BLOCKFIELD_CP_URL
  }
})

test('CP client rejects corrupt gate answers', async () => {
  const server = await fakeCp((_, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ schema: 2, mode: 'open' }))
  })
  try {
    process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
    process.env.BLOCKFIELD_CP_GATE_READ_TOKEN = 'read-t'
    await assert.rejects(readGateCp(), /неверное состояние/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    delete process.env.BLOCKFIELD_CP_URL
  }
})
