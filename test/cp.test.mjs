import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { maintenanceFromCp, readGateCp, postGateCp, gateToggle } from '../src/lib/cp.ts'
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

test('CP client reads gate and toggles it end-to-end (fail-before for the API shape)', async () => {
  let state = { schema: 1, revision: 4, mode: 'open', message: '', since: 1, observedAt: 2 }
  const seen = []
  const server = await fakeCp((req, res) => {
    seen.push([req.method, req.url, req.headers.authorization])
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'GET') return res.end(JSON.stringify(state))
      const payload = JSON.parse(body)
      assert.equal(payload.expectedRevision, state.revision)
      assert.match(payload.idempotencyKey, /.+/)
      assert.deepEqual(payload.actor, { id: 'owner-1', role: 'owner' })
      state = { ...state, revision: state.revision + 1, mode: payload.mode }
      res.statusCode = 202
      res.end(JSON.stringify({ operationId: 'op1', revision: state.revision }))
    })
  })
  try {
    Object.assign(process.env, {
      BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
      BLOCKFIELD_CP_GATE_READ_TOKEN: 'read-t',
      BLOCKFIELD_CP_GATE_WRITE_TOKEN: 'write-t',
    })
    assert.equal(await readGateCp(), null)
    const out = await postGateCp('maintenance', '', { id: 'owner-1', role: 'owner' }, 'k1')
    assert.equal(out.revision, 5)
    const closed = await readGateCp()
    assert.equal(
      closed?.message,
      'На сервере проводятся технические работы. Обычный вход временно недоступен.',
    )
    assert.deepEqual(
      seen.map(([m, u]) => [m, u]),
      [
        ['GET', '/v1/gate'],
        ['GET', '/v1/gate'],
        ['POST', '/v1/gate'],
        ['GET', '/v1/gate'],
      ],
    )
    assert.ok(seen.every(([, , auth]) => auth?.startsWith('Bearer ')))
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
