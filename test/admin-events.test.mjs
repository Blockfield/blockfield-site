import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  eventAllowed,
  heartbeat,
  presenceList,
  publish,
  subscribe,
} from '../src/lib/admin-events.ts'
import { handleAdmin } from '../src/lib/admin.ts'
import { database } from './storage.mjs'

const UUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const actor = { uuid: UUID, name: 'Staff', role: 'admin' }
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bf-events-'))
  mkdirSync(join(directory, 'results'))
  const env = {
    BLOCKFIELD_ADMIN_DIR: directory,
    BLOCKFIELD_SETTINGS_DIR: directory,
    BLOCKFIELD_ADMIN_DEV_USER: `${UUID}:Staff`,
    BLOCKFIELD_OWNER_UUIDS: UUID,
    BLOCKFIELD_SERVER_HOST: '127.0.0.1',
    BLOCKFIELD_SERVER_PORT: '1',
    BLOCKFIELD_LOBBY_HOST: '127.0.0.1',
    BLOCKFIELD_LOBBY_PORT: '1',
    NODE_ENV: 'test',
  }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
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

test('file watchers emit settings, catalog invalidation and request results', async (t) => {
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
  const id = '12345678-1234-4234-8234-123456789abc'
  writeFileSync(join(directory, 'results', `${id}.json`), '{"ok":true}')
  await until(() => received.some((event) => event.type === 'request' && event.id === id))
  assert.deepEqual(received.find((event) => event.type === 'request').result, { ok: true })
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
