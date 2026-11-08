import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { cpModerationConfigured, moderationCpKinds, postModerationCp } from '../src/lib/cp.ts'

async function fakeCp(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

const GEN = '12345678-1234-4234-8234-123456789012'

function env(t, server) {
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  Object.assign(process.env, {
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_MODERATION_TOKEN: 'mod-t',
    BLOCKFIELD_CP_CONSUMER_ID: 'game',
    BLOCKFIELD_CP_CONSUMER_GENERATION: GEN,
  })
}

test('moderation flag needs URL, token and consumer generation', () => {
  assert.deepEqual([...moderationCpKinds].sort(), [
    'class-lock',
    'class-unlock',
    'pardon',
    'range',
    'say',
    'stop-room',
    'team-kick',
  ])
  // list stays on RCON: it is a read and CP ACKs carry no output.
  assert.equal(moderationCpKinds.includes('list'), false)
  assert.equal(
    cpModerationConfigured({
      BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
      BLOCKFIELD_CP_MODERATION_TOKEN: 't',
      BLOCKFIELD_CP_CONSUMER_GENERATION: GEN,
    }),
    true,
  )
  assert.equal(cpModerationConfigured({ BLOCKFIELD_CP_URL: 'http://127.0.0.1:9' }), false)
  assert.equal(
    cpModerationConfigured({
      BLOCKFIELD_CP_URL: 'http://127.0.0.1:9',
      BLOCKFIELD_CP_MODERATION_TOKEN: 't',
      BLOCKFIELD_CP_CONSUMER_GENERATION: 'stale',
    }),
    false,
  )
  delete process.env.BLOCKFIELD_CP_MODERATION_TOKEN
  delete process.env.BLOCKFIELD_CP_CONSUMER_GENERATION
  assert.equal(cpModerationConfigured(), false)
})

test('moderation posts the typed action envelope (fail-before for the CP shape)', async (t) => {
  const seen = []
  const server = await fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push([req.method, req.url, req.headers.authorization, JSON.parse(body)])
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(JSON.stringify({ operationId: 'op-say', revision: null, status: 'accepted' }))
    })
  })
  try {
    env(t, server)
    const out = await postModerationCp('say', { text: 'Рестарт через 5 минут' })
    assert.equal(out.operationId, 'op-say')
    const [[method, url, auth, payload]] = seen
    assert.equal(method, 'POST')
    assert.equal(url, '/v2/actions/moderation.say')
    assert.equal(auth, 'Bearer mod-t')
    assert.equal(payload.environment, 'prod')
    assert.equal(payload.backend, 'game')
    assert.equal(payload.consumerId, 'game')
    assert.equal(payload.generation, GEN)
    assert.equal(payload.text, 'Рестарт через 5 минут')
    assert.match(payload.idempotencyKey, /.+/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('moderation maps CP refusals to site errors', async (t) => {
  const server = await fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = Number(req.url.endsWith('say') ? 403 : 409)
      res.end(JSON.stringify({ error: req.url.endsWith('say') ? 'forbidden' : 'consumer_lag' }))
    })
  })
  try {
    env(t, server)
    // No moderation scopes on the site credential yet: coordinator step, not a silent failure.
    await assert.rejects(postModerationCp('say', { text: 'hi' }), /координатору/)
    await assert.rejects(postModerationCp('range', { op: 'open' }), /позже/)
    await assert.rejects(postModerationCp('list', {}), /Неизвестное действие/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
