import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  awaitOperationCp,
  cpModerationConfigured,
  moderationCpKinds,
  postModerationCp,
} from '../src/lib/cp.ts'

async function fakeCp(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

const GEN = '12345678-1234-4234-8234-123456789012'
const ACTOR = 'd94f8b1e2c3a4d5e8f7091a2b3c4d5e6'

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
    'ban',
    'class-lock',
    'class-unlock',
    'kick',
    'list',
    'maintenance',
    'pardon',
    'range',
    'say',
    'stop-room',
    'team-kick',
  ])
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
    const out = await postModerationCp('say', ACTOR, { text: 'Рестарт через 5 минут' })
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
    await assert.rejects(postModerationCp('say', ACTOR, { text: 'hi' }), /координатору/)
    await assert.rejects(postModerationCp('range', ACTOR, { op: 'open' }), /позже/)
    await assert.rejects(postModerationCp('op', ACTOR, {}), /Неизвестное действие/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('moderation sends the acting admin uuid for say', async (t) => {
  const seen = []
  const server = await fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push(JSON.parse(body))
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(JSON.stringify({ operationId: 'op-say', revision: null, status: 'accepted' }))
    })
  })
  try {
    env(t, server)
    await postModerationCp('say', 'd94f8b1e2c3a4d5e8f7091a2b3c4d5e6', {
      text: 'Рестарт через 5 минут',
    })
    const [payload] = seen
    assert.equal(payload.actorAccountId, 'd94f8b1e-2c3a-4d5e-8f70-91a2b3c4d5e6')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('moderation sends the acting admin uuid for pardon', async (t) => {
  const seen = []
  const server = await fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push(JSON.parse(body))
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(JSON.stringify({ operationId: 'op-pardon', revision: null, status: 'accepted' }))
    })
  })
  try {
    env(t, server)
    await postModerationCp('pardon', 'D94F8B1E-2C3A-4D5E-8F70-91A2B3C4D5E6', {
      player: 'Steve_01',
    })
    const [payload] = seen
    assert.equal(payload.player, 'Steve_01')
    assert.equal(payload.actorAccountId, 'd94f8b1e-2c3a-4d5e-8f70-91a2b3c4d5e6')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

async function rejectsCpProblem(t, server, code, status, message) {
  env(t, server)
  await assert.rejects(
    postModerationCp('say', 'd94f8b1e2c3a4d5e8f7091a2b3c4d5e6', { text: 'hi' }),
    (error) => {
      assert.equal(error.status, status)
      assert.match(error.message, message)
      assert.equal(error.code, code)
      return true
    },
  )
}

function cpErrorServer(code, status) {
  return fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = status
      res.end(JSON.stringify({ error: code }))
    })
  })
}

test('moderation maps a missing actor assertion to a coordinator error', async (t) => {
  const server = await cpErrorServer('service_actor_required', 403)
  try {
    await rejectsCpProblem(t, server, 'service_actor_required', 500, /не передал автора/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('moderation maps a forbidden actor assertion to a coordinator error', async (t) => {
  const server = await cpErrorServer('actor_forbidden', 403)
  try {
    await rejectsCpProblem(t, server, 'actor_forbidden', 500, /не вправе подтверждать автора/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('moderation maps an ineligible actor to a site error', async (t) => {
  const server = await cpErrorServer('ineligible_account', 403)
  try {
    await rejectsCpProblem(t, server, 'ineligible_account', 403, /не может выполнять модерацию/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('moderation maps an unknown actor to a site error', async (t) => {
  const server = await cpErrorServer('account_not_found', 404)
  try {
    await rejectsCpProblem(t, server, 'account_not_found', 404, /Участник не найден/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('moderation forwards a caller-supplied idempotency key verbatim', async (t) => {
  const seen = []
  const server = await fakeCp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push(JSON.parse(body).idempotencyKey)
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 202
      res.end(JSON.stringify({ operationId: 'op-k', revision: null, status: 'accepted' }))
    })
  })
  try {
    env(t, server)
    const key = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await postModerationCp('say', ACTOR, { text: 'hi' }, { idempotencyKey: key })
    await postModerationCp('say', ACTOR, { text: 'hi' }, { idempotencyKey: key })
    assert.deepEqual(seen, [key, key])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('awaitOperationCp polls until the game settles and returns the last receipt output', async (t) => {
  let reads = 0
  const server = await fakeCp((req, res) => {
    reads++
    res.setHeader('Content-Type', 'application/json')
    assert.equal(req.headers.authorization, 'Bearer mod-token')
    res.end(
      JSON.stringify(
        reads < 3
          ? { status: 'received', receipts: [] }
          : {
              status: 'effective',
              receipts: [
                { state: 'received', result: { code: 'ok' } },
                { state: 'effective', result: { code: 'ok', output: 'There are 0 players' } },
              ],
            },
      ),
    )
  })
  try {
    env(t, server)
    assert.deepEqual(await awaitOperationCp('op-1', 'mod-token', { intervalMs: 1 }), {
      status: 'effective',
      output: 'There are 0 players',
    })
    assert.equal(reads, 3)
    reads = 0
    // Never settled within the window: pending, never reported as success.
    assert.deepEqual(await awaitOperationCp('op-2', 'mod-token', { intervalMs: 1, timeoutMs: 0 }), {
      status: 'pending',
      output: '',
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
