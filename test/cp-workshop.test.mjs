import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { cpWorkshopConfigured, postWorkshopCp, workshopCpKinds } from '../src/lib/cp.ts'

const GEN = '12345678-1234-4234-8234-123456789012'

function env(t, server) {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_WORKSHOP_TOKEN: 'wsh-t',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_ID: 'workshop',
    BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: GEN,
  })
}

async function fakeCp(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

const ACTOR = { draslId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Moddy' }

test('workshop client covers message/wake/cancel; members stays on the inbox', () => {
  assert.deepEqual([...workshopCpKinds].sort(), ['cancel', 'message', 'wake'])
  // members needs a person session plus the owner step-up, which the site
  // service credential can never hold: no client call for it.
  assert.equal(workshopCpKinds.includes('members'), false)
  assert.equal(
    cpWorkshopConfigured({
      BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
      BLOCKFIELD_CP_WORKSHOP_TOKEN: 't',
      BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: GEN,
    }),
    true,
  )
  assert.equal(cpWorkshopConfigured({ BLOCKFIELD_CP_URL: 'http://127.0.0.1:9' }), false)
  assert.equal(
    cpWorkshopConfigured({
      BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
      BLOCKFIELD_CP_WORKSHOP_TOKEN: 't',
      BLOCKFIELD_CP_WORKSHOP_CONSUMER_GENERATION: 'stale',
    }),
    false,
  )
})

test('workshop posts the typed envelope (fail-before for the CP shape)', async (t) => {
  const seen = []
  const server = await fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push([req.method, req.url, req.headers.authorization, JSON.parse(body)])
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(JSON.stringify({ operationId: 'op-wake', revision: null, status: 'accepted' }))
    })
  })
  t.after(() => server.close())
  env(t, server)
  const out = await postWorkshopCp('wake', ACTOR)
  assert.equal(out.operationId, 'op-wake')
  const [[method, url, auth, payload]] = seen
  assert.equal(method, 'POST')
  assert.equal(url, '/v2/workshop/wake')
  assert.equal(auth, 'Bearer wsh-t')
  assert.equal(payload.environment, 'prod')
  assert.equal(payload.consumerId, 'workshop')
  assert.equal(payload.generation, GEN)
  assert.equal(payload.target, '*')
  assert.deepEqual(payload.actor, ACTOR)
  assert.match(payload.idempotencyKey, /.+/)
})

test('workshop message carries the validated text', async (t) => {
  const seen = []
  const server = await fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push([req.url, JSON.parse(body)])
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(JSON.stringify({ operationId: 'op-msg', revision: null, status: 'accepted' }))
    })
  })
  t.after(() => server.close())
  env(t, server)
  await postWorkshopCp('message', ACTOR, { message: 'Перерыв 5 минут' })
  assert.deepEqual(
    seen.map(([u, b]) => [u, b.message]),
    [['/v2/workshop/message', 'Перерыв 5 минут']],
  )
})

test('workshop maps CP refusals to site errors', async (t) => {
  const server = await fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = Number(req.url.endsWith('message') ? 403 : 409)
      res.end(JSON.stringify({ error: req.url.endsWith('message') ? 'forbidden' : 'consumer_lag' }))
    })
  })
  t.after(() => server.close())
  env(t, server)
  await assert.rejects(postWorkshopCp('message', ACTOR, { message: 'hi' }), /координатору/)
  await assert.rejects(postWorkshopCp('wake', ACTOR), /позже/)
  await assert.rejects(postWorkshopCp('members', ACTOR), /Неизвестное действие/)
})

test('workshop forwards a caller-supplied idempotency key verbatim', async (t) => {
  const seen = []
  const server = await fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push(JSON.parse(body).idempotencyKey)
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(JSON.stringify({ operationId: 'op-c', revision: null, status: 'accepted' }))
    })
  })
  t.after(() => server.close())
  env(t, server)
  const key = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  await postWorkshopCp('cancel', ACTOR, {}, { idempotencyKey: key })
  await postWorkshopCp('cancel', ACTOR, {}, { idempotencyKey: key })
  assert.deepEqual(seen, [key, key])
})
