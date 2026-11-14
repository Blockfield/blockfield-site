import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import {
  eventAllowed,
  heartbeat,
  presenceList,
  publish,
  subscribe,
  trackWorkshopRequest,
} from '../src/lib/admin-events.ts'
import { handleAdmin } from '../src/lib/admin.ts'
import { database } from './storage.mjs'

const UUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const actor = { uuid: UUID, name: 'Staff', role: 'admin' }
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bf-events-'))
  const env = {
    BLOCKFIELD_SETTINGS_DIR: directory,
    BLOCKFIELD_ADMIN_DEV_USER: `${UUID}:Staff`,
    BLOCKFIELD_OWNER_UUIDS: UUID,
    BLOCKFIELD_SERVER_HOST: '127.0.0.1',
    BLOCKFIELD_SERVER_PORT: '1',
    BLOCKFIELD_LOBBY_HOST: '127.0.0.1',
    BLOCKFIELD_LOBBY_PORT: '1',
    BLOCKFIELD_CP_URL: undefined,
    BLOCKFIELD_CP_WORKSHOP_TOKEN: undefined,
    NODE_ENV: 'test',
  }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}
async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'event deadline exceeded')
    await delay(10)
  }
}
function context(path, init = {}) {
  const url = new URL(`http://localhost/api/admin/${path}`)
  return { url, request: new Request(url, init), cookies: { get: () => undefined } }
}

test('subscriptions filter permissions and replay only permitted events', (t) => {
  setup(t)
  const received = []
  const unsubscribe = subscribe(
    (event) => eventAllowed('builder', event),
    (event) => received.push(event),
  )
  t.after(unsubscribe)
  const id = publish({ type: 'rooms', rooms: { online: 1 } })
  publish({ type: 'audit', entry: { action: 'secret' } })
  publish({ type: 'settings', settings: { revision: 2 } })
  publish({ type: 'rooms', rooms: { online: 2 } })
  assert.equal(
    received.some((event) => ['audit', 'settings'].includes(event.type)),
    false,
  )
  assert.deepEqual(
    received.filter((event) => event.type === 'rooms').map((event) => event.rooms.online),
    [1, 2],
  )
  const replay = []
  const stop = subscribe(
    (event) => eventAllowed('moderator', event),
    (event, id) => {
      if (id) replay.push(event)
    },
    id,
  )
  stop()
  assert.deepEqual(
    replay.map((event) => event.type),
    ['rooms'],
  )
  assert.equal(eventAllowed('admin', { type: 'audit' }), true)
  assert.equal(eventAllowed('admin', { type: 'settings' }), true)
  assert.equal(eventAllowed(null, { type: 'rooms' }), false)
})

test('presence adds, changes tab, expires, validates and never audits', async (t) => {
  setup(t)
  const store = await database(t)
  const events = []
  const stop = subscribe(
    (event) => event.type === 'presence',
    (event) => events.push(event),
  )
  t.after(stop)
  const initial = events.length
  heartbeat(actor, 'overview')
  heartbeat(actor, 'overview')
  heartbeat(actor, 'settings')
  assert.equal(events.length, initial + 2)
  assert.equal(presenceList()[0].tab, 'settings')
  assert.deepEqual(presenceList(Date.now() + 90_001), [])
  const post = (tab) =>
    handleAdmin(
      context('presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab }),
      }),
      'presence',
      store,
    )
  assert.equal((await post('overview')).status, 200)
  for (const tab of ['', 'a'.repeat(25), '../settings', 4])
    assert.equal((await post(tab)).status, 400)
  assert.deepEqual(await store.auditLog(), [])
  presenceList(Date.now() + 90_001)
  delete process.env.BLOCKFIELD_OWNER_UUIDS
  assert.equal((await post('overview')).status, 403)
  assert.equal((await handleAdmin(context('events'), 'events', store)).status, 403)
})

test('SSE headers, initial snapshots, event delivery, abort and multiple-stream presence', async (t) => {
  setup(t)
  const store = await database(t)
  const abort = new AbortController(),
    secondAbort = new AbortController()
  t.after(() => {
    abort.abort()
    secondAbort.abort()
  })
  const response = await handleAdmin(context('events', { signal: abort.signal }), 'events', store)
  const second = await handleAdmin(
    context('events', { signal: secondAbort.signal }),
    'events',
    store,
  )
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  const reader = response.body.getReader()
  let text = ''
  const readUntil = async (marker) => {
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('stream deadline exceeded')), 3000)
    })
    try {
      while (!text.includes(marker)) {
        const value = await Promise.race([reader.read(), deadline])
        assert.equal(value.done, false)
        text += new TextDecoder().decode(value.value)
      }
    } finally {
      clearTimeout(timer)
    }
  }
  await readUntil('event: status')
  assert.match(text, /retry: 3000/)
  assert.match(text, /event: settings/)
  assert.match(text, /"rooms":/)
  const id = publish({ type: 'request', id: 'controller-id', result: { ok: true } })
  await readUntil('event: request')
  assert.ok(text.includes(`id: ${id}\n`))
  assert.match(text, /"id":"controller-id"/)
  heartbeat(actor, 'overview')
  abort.abort()
  assert.equal(presenceList().length, 1)
  secondAbort.abort()
  assert.deepEqual(presenceList(), [])
  while (!(await reader.read()).done) {
    /* Drain queued frames after abort. */
  }
  const canceled = await handleAdmin(context('events'), 'events', store)
  await canceled.body.cancel()
  assert.equal(second.status, 200)
})

test('file watchers emit settings and catalog invalidation', async (t) => {
  const directory = setup(t)
  const received = []
  const stop = subscribe(
    () => true,
    (event) => received.push(event),
  )
  t.after(stop)
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ schema: 1, revision: 7 }))
  await until(() =>
    received.some((event) => event.type === 'settings' && event.settings.revision === 7),
  )
  writeFileSync(join(directory, 'gun-balance.json'), '{}')
  await until(() =>
    received.some((event) => event.type === 'settings' && event.gunBalance === true),
  )
  writeFileSync(join(directory, 'kits.json'), '{}')
  await until(() => received.some((event) => event.type === 'settings' && event.kits === true))
})

test('workshop SSE emits status and request results from CP', async (t) => {
  setup(t)
  const id = '12345678-1234-4234-8234-123456789abc'
  let sseRes = null
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/v2/workshop/state') {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          seq: 5,
          documents: {
            status: {
              seq: 5,
              updatedAt: 1,
              revision: 1,
              name: 'status',
              value: { phase: 'sleeping' },
            },
          },
        }),
      )
      return
    }
    if (url.pathname === '/v2/workshop/state/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      sseRes = res
      res.write(': keepalive\n\n')
      req.on('close', () => {
        sseRes = null
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    sseRes?.end()
    server.closeAllConnections?.()
    server.close()
  })
  process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
  process.env.BLOCKFIELD_CP_WORKSHOP_TOKEN = 'wsh-t'

  const received = []
  const stop = subscribe(
    () => true,
    (event) => received.push(event),
  )
  t.after(stop)
  await until(() => sseRes !== null)
  sseRes.write(
    `id: 6\nevent: state\ndata: ${JSON.stringify({ name: 'status', seq: 6, value: { phase: 'ready' } })}\n\n`,
  )
  sseRes.write(
    `id: 7\nevent: state\ndata: ${JSON.stringify({ name: `result:${id}`, seq: 7, value: { ok: true } })}\n\n`,
  )
  await until(() => received.some((event) => event.type === 'request' && event.id === id))
  await until(() =>
    received.some((event) => event.type === 'status' && event.status?.phase === 'ready'),
  )
  assert.deepEqual(received.find((event) => event.type === 'request').result, { ok: true })
})

test('workshop SSE resync publishes fresh snapshot, reconciles results, and closes old streams', async (t) => {
  setup(t)
  const pendingOpId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const untrackedOpId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  let stateSeq = 5
  let currentStatus = { phase: 'sleeping' }
  let currentSession = null
  let includeResults = false
  const stateQueries = []
  const openStreams = new Set()
  let totalStreams = 0
  let closedStreams = 0
  let firstStreamRes = null

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/v2/workshop/state') {
      stateQueries.push(url.searchParams.get('names') ?? '')
      const documents = {
        status: {
          seq: stateSeq,
          updatedAt: 1,
          revision: 1,
          name: 'status',
          value: currentStatus,
        },
        session: {
          seq: stateSeq,
          updatedAt: 1,
          revision: 1,
          name: 'session',
          value: currentSession,
        },
      }
      if (includeResults) {
        documents[`result:${pendingOpId}`] = {
          seq: stateSeq,
          updatedAt: 2,
          revision: 1,
          name: `result:${pendingOpId}`,
          value: { ok: true, mapId: 'fields' },
        }
        documents[`result:${untrackedOpId}`] = {
          seq: stateSeq,
          updatedAt: 2,
          revision: 1,
          name: `result:${untrackedOpId}`,
          value: { ok: false, error: 'missed' },
        }
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ seq: stateSeq, documents }))
      return
    }
    if (url.pathname === '/v2/workshop/state/events') {
      totalStreams++
      openStreams.add(res)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': keepalive\n\n')
      if (totalStreams === 1) firstStreamRes = res
      req.on('close', () => {
        if (openStreams.delete(res)) closedStreams++
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    for (const res of openStreams) res.end()
    server.closeAllConnections?.()
    server.close()
  })
  process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
  process.env.BLOCKFIELD_CP_WORKSHOP_TOKEN = 'wsh-t'

  trackWorkshopRequest(pendingOpId)
  const received = []
  const stop = subscribe(
    () => true,
    (event) => received.push(event),
  )
  t.after(stop)

  await until(() => firstStreamRes !== null)
  assert.equal(openStreams.size, 1)

  const initialCount = received.length
  stateSeq = 9
  currentStatus = { phase: 'workshop', gate: 'builders' }
  currentSession = { id: 'sess-2' }
  includeResults = true
  // Trigger resync without closing the server-side stream; client must cancel/abort it.
  firstStreamRes.write('event: resync\ndata: {"reason":"gap"}\n\n')

  await until(() => totalStreams === 2)
  await until(() => closedStreams >= 1)
  assert.equal(openStreams.size, 1, 'old SSE stream must be closed after resync')
  await until(() =>
    received
      .slice(initialCount)
      .some(
        (event) =>
          event.type === 'status' &&
          event.status?.phase === 'workshop' &&
          event.session?.id === 'sess-2',
      ),
  )
  await until(() => received.some((event) => event.type === 'request' && event.id === pendingOpId))
  await until(() =>
    received.some((event) => event.type === 'request' && event.id === untrackedOpId),
  )
  assert.ok(
    stateQueries.some((q) => q.split(',').includes(`result:${pendingOpId}`)),
    'resync read must request tracked pending result documents',
  )
  assert.deepEqual(
    received.find((event) => event.type === 'request' && event.id === pendingOpId).result,
    { ok: true, mapId: 'fields' },
  )

  stop()
  await until(() => openStreams.size === 0)
})

test('audit events contain the exact stored row including truncation and generated id', async (t) => {
  setup(t)
  const store = await database(t)
  const events = []
  const stop = subscribe(
    (event) => event.type === 'audit',
    (event) => events.push(event),
  )
  t.after(stop)
  await store.audit({
    actorUuid: UUID,
    actorName: 'Staff',
    role: 'admin',
    action: 'test',
    target: 'x'.repeat(300),
    detail: { value: 1 },
    ok: true,
  })
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].entry, (await store.auditLog())[0])
})

test('missing export directories log once and still deliver initial settings', (t) => {
  const directory = setup(t)
  rmSync(directory, { recursive: true })
  const warning = t.mock.method(console, 'warn', () => {})
  const events = []
  const stop = subscribe(
    () => true,
    (event) => events.push(event),
  )
  assert.deepEqual(events.find((event) => event.type === 'settings').settings, {
    schema: 1,
    revision: 0,
  })
  stop()
  const warnings = warning.mock.callCount()
  assert.ok(warnings > 0)
  subscribe(
    () => true,
    () => {},
  )()
  assert.equal(warning.mock.callCount(), warnings)
})

test('a throwing subscriber is dropped and the other subscribers still receive the event', (t) => {
  setup(t)
  const received = []
  const broken = subscribe(
    () => true,
    () => {
      throw new Error('socket closed')
    },
  )
  const healthy = subscribe(
    () => true,
    (event) => received.push(event.type),
  )
  t.after(() => {
    broken()
    healthy()
  })
  assert.doesNotThrow(() => publish({ type: 'presence', presence: [] }))
  assert.deepEqual(
    received.filter((type) => type === 'presence').length >= 1,
    true,
    'healthy subscriber still served',
  )
  publish({ type: 'presence', presence: [] })
  assert.equal(received.filter((type) => type === 'presence').length >= 2, true)
})

test('snapshot cursor replays results registered while reconciliation is in flight', async (t) => {
  setup(t)
  const first = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const late = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  let resultRead
  let after
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.endsWith('/events')) {
      after = url.searchParams.get('after')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        `event: state\ndata: ${JSON.stringify({ seq: 6, name: `result:${late}`, value: { ok: true } })}\n\n`,
      )
      return
    }
    const names = url.searchParams.get('names') ?? ''
    if (names.includes(`result:${first}`)) {
      resultRead = res
      return
    }
    res.end(JSON.stringify({ seq: 5, documents: {} }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
  process.env.BLOCKFIELD_CP_WORKSHOP_TOKEN = 'wsh-t'
  trackWorkshopRequest(first)
  const received = []
  const stop = subscribe(
    () => true,
    (event) => received.push(event),
  )
  t.after(stop)
  await until(() => resultRead)
  trackWorkshopRequest(late)
  resultRead.end(JSON.stringify({ seq: 7, documents: { status: { seq: 7, value: {} } } }))
  await until(() => received.some((event) => event.type === 'request' && event.id === late))
  assert.equal(after, '5')
})

test('delayed initial status cannot overwrite a newer resync status', async (t) => {
  setup(t)
  let initialResponse
  let stream
  let stateSeq = 5
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      if (!stream) stream = res
      return
    }
    if (url.searchParams.get('names') === 'status,session' && !initialResponse) {
      initialResponse = res
      return
    }
    res.end(
      JSON.stringify({
        seq: stateSeq,
        documents: { status: { seq: stateSeq, value: { phase: stateSeq === 5 ? 'old' : 'new' } } },
      }),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
  process.env.BLOCKFIELD_CP_WORKSHOP_TOKEN = 'wsh-t'
  const received = []
  const stop = subscribe(
    () => true,
    (event) => received.push(event),
  )
  t.after(stop)
  await until(() => stream && initialResponse)
  stateSeq = 9
  stream.write('event: resync\ndata: {}\n\n')
  await until(() =>
    received.some((event) => event.type === 'status' && event.status?.phase === 'new'),
  )
  initialResponse.end(
    JSON.stringify({ seq: 5, documents: { status: { seq: 5, value: { phase: 'old' } } } }),
  )
  await delay(100)
  assert.deepEqual(
    received.filter((event) => event.type === 'status').map((event) => event.status?.phase),
    ['new'],
  )
})

test('a late registration reconciles a result already behind the snapshot cursor', async (t) => {
  setup(t)
  const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  let streamOpen = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.endsWith('/events')) {
      streamOpen = true
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      return
    }
    const documents = url.searchParams.get('names')?.includes(`result:${id}`)
      ? { [`result:${id}`]: { seq: 4, value: { ok: true } } }
      : {}
    res.end(JSON.stringify({ seq: 5, documents }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
  process.env.BLOCKFIELD_CP_WORKSHOP_TOKEN = 'wsh-t'
  const received = []
  const stop = subscribe(
    () => true,
    (event) => received.push(event),
  )
  t.after(stop)
  await until(() => streamOpen)
  trackWorkshopRequest(id)
  await until(() => received.some((event) => event.type === 'request' && event.id === id))
})

test('an older replay cannot overwrite a newer initial status', async (t) => {
  setup(t)
  let stream
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.endsWith('/events')) {
      stream = res
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      return
    }
    const initial = url.searchParams.get('names') === 'status,session'
    const seq = initial ? 9 : 5
    res.end(
      JSON.stringify({
        seq,
        documents: { status: { seq, value: { phase: initial ? 'new' : 'old' } } },
      }),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
  process.env.BLOCKFIELD_CP_WORKSHOP_TOKEN = 'wsh-t'
  const received = []
  const stop = subscribe(
    () => true,
    (event) => received.push(event),
  )
  t.after(stop)
  await until(
    () =>
      stream && received.some((event) => event.type === 'status' && event.status?.phase === 'new'),
  )
  stream.write(
    `event: state\ndata: ${JSON.stringify({ seq: 6, name: 'status', value: { phase: 'old' } })}\n\n`,
  )
  await delay(100)
  assert.deepEqual(
    received.filter((event) => event.type === 'status').map((event) => event.status?.phase),
    ['new'],
  )
})
