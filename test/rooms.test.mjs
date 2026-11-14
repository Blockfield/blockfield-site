import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { parsePresenceRooms, maintenanceFrom, validBuild, validBattle } from '../src/lib/rooms.ts'

const room = {
  id: '12345678-1234-1234-1234-123456789abc',
  name: 'Комната 1',
  mode: 'Захват точек',
  map: 'Карта',
  phase: 'GAME',
  players: 4,
  joinable: true,
}

test('presence rooms accept valid lists and reject bad rooms', () => {
  assert.deepEqual(parsePresenceRooms({ rooms: [] }).rooms, [])
  for (const invalid of [
    { ...room, id: '../file' },
    { ...room, players: -1 },
    { ...room, phase: 'unknown' },
  ])
    assert.throws(() => parsePresenceRooms({ rooms: [invalid] }))
})

test('battle data preserves capture state and rejects invalid progress', () => {
  const battle = {
    red: 720,
    blue: 685,
    points: [
      { id: 'a', name: 'A', owner: 'BLUE', claiming: 'NONE', capturing: 'RED', progress: 35 },
    ],
  }
  assert.deepEqual(parsePresenceRooms({ rooms: [{ ...room, battle }] }).rooms[0].battle, battle)
  assert.ok(validBattle(battle))
  assert.ok(!validBattle({ ...battle, red: -1 }))
  assert.ok(!validBattle({ ...battle, points: [{ ...battle.points[0], progress: 101 }] }))
})

test('presence rooms tolerate mod#28 fields and pass build through', () => {
  const ranked = {
    ...room,
    phase: 'PREPARING',
    joinable: false,
    format: 'ranked',
    admission: 'waiting',
    ready: { ready: 3, required: 4 },
  }
  const status = parsePresenceRooms({
    rooms: [{ ...room, format: 'casual' }, ranked],
    build: 'v2.31.6',
  })
  assert.equal(status.rooms.length, 2)
  assert.equal(status.build, 'v2.31.6')
  for (const build of ['latest', '<b>v1</b>', 7, null, 'xyz'])
    assert.equal('build' in parsePresenceRooms({ rooms: [], build }), validBuild(build))
})

test('gate values fail closed with a bounded message', () => {
  assert.equal(maintenanceFrom({ mode: 'game', message: 'x' }), null)
  assert.deepEqual(maintenanceFrom({ mode: 'maintenance', message: '' }), {
    message: 'На сервере проводятся технические работы. Обычный вход временно недоступен.',
    since: null,
  })
  assert.deepEqual(maintenanceFrom({ mode: 'workshop', message: '  Карта  ', since: 5 }), {
    message: 'Карта',
    since: 5,
  })
})

function fakeCp(t, { gate = null, presence = null, gateStatus = 200, presenceStatus = 200 } = {}) {
  const server = http.createServer((req, res) => {
    const answer = (code, data) => {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(data))
    }
    if (req.url.startsWith('/v1/gate')) {
      if (gateStatus !== 200) return answer(gateStatus, { error: 'x' })
      return answer(200, gate)
    }
    if (req.url.startsWith('/v2/rooms')) {
      if (presenceStatus !== 200) return answer(presenceStatus, { error: 'x' })
      return answer(200, presence)
    }
    return answer(404, { error: 'not_found' })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const saved = { ...process.env }
      t.after(() => {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
        Object.assign(process.env, saved)
      })
      t.after(() => new Promise((r) => server.close(r)))
      Object.assign(process.env, {
        BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
        BLOCKFIELD_CP_GATE_READ_TOKEN: 'gate-t',
        BLOCKFIELD_CP_SETTINGS_TOKEN: 'settings-t',
        BLOCKFIELD_CP_CONSUMER_ID: 'game',
      })
      resolve(server)
    })
  })
}

const liveGate = {
  schema: 1,
  revision: 1,
  mode: 'open',
  message: '',
  since: null,
  observedAt: Date.now(),
}
const livePresence = (over = {}) => ({
  initialized: true,
  reportedAt: new Date().toISOString(),
  presence: { rooms: [room], ...over },
})

test('currentRooms serves CP rooms when the presence report is fresh', async (t) => {
  await fakeCp(t, { gate: liveGate, presence: livePresence() })
  const { currentRooms } = await import('../src/lib/rooms.ts?cp-fresh')
  const status = await currentRooms()
  assert.equal(status.available, true)
  assert.deepEqual(status.rooms, [room])
  assert.equal('maintenance' in status, false)
})

test('currentRooms marks the game down on stale or unreadable presence', async (t) => {
  await fakeCp(t, {
    gate: liveGate,
    presence: {
      initialized: true,
      reportedAt: new Date(Date.now() - 60_000).toISOString(),
      presence: { rooms: [room] },
    },
  })
  const stale = await import('../src/lib/rooms.ts?cp-stale')
  assert.equal((await stale.currentRooms()).available, false)
  assert.deepEqual((await stale.currentRooms()).rooms, [])

  await fakeCp(t, { gate: liveGate, presenceStatus: 500 })
  const down = await import('../src/lib/rooms.ts?cp-down')
  assert.equal((await down.currentRooms()).available, false)
})

test('currentRooms fails closed when the gate is unreadable, draining shows maintenance', async (t) => {
  await fakeCp(t, { gateStatus: 500, presence: livePresence() })
  const closed = await import('../src/lib/rooms.ts?cp-gate-closed')
  const shut = await closed.currentRooms()
  assert.ok(shut.maintenance, 'unreadable gate fails closed')

  await fakeCp(t, { gate: liveGate, presence: livePresence({ draining: true }) })
  const draining = await import('../src/lib/rooms.ts?cp-draining')
  const status = await draining.currentRooms()
  assert.equal(status.available, true)
  assert.ok(status.maintenance, 'draining maps to maintenance while the gate stays open')
})

test('cachedRooms serves the snapshot without waiting on a slow CP refresh', async (t) => {
  let hits = 0
  const server = http.createServer((req, res) => {
    const answer = (code, data) => {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(data))
    }
    if (req.url.startsWith('/v1/gate')) return answer(200, liveGate)
    hits++
    const payload =
      hits === 1 ? livePresence() : livePresence({ rooms: [{ ...room, name: 'Комната 2' }] })
    if (hits > 1) setTimeout(() => answer(200, payload), 2000)
    else answer(200, payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const saved = { ...process.env }
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  t.after(() => server.close())
  Object.assign(process.env, {
    BLOCKFIELD_CP_URL: `http://127.0.0.1:${server.address().port}`,
    BLOCKFIELD_CP_GATE_READ_TOKEN: 'gate-t',
    BLOCKFIELD_CP_SETTINGS_TOKEN: 'settings-t',
    BLOCKFIELD_CP_CONSUMER_ID: 'game',
  })
  const mod = await import('../src/lib/rooms.ts?cp-cached')
  assert.deepEqual((await mod.currentRooms()).rooms, [room])
  await new Promise((resolve) => setTimeout(resolve, 5100))
  const started = Date.now()
  assert.deepEqual((await mod.cachedRooms()).rooms, [room])
  assert.ok(Date.now() - started < 1000, 'cached read does not block on CP')
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.deepEqual((await mod.cachedRooms()).rooms, [{ ...room, name: 'Комната 2' }])
})

test('future and malformed reports make the game unavailable', async (t) => {
  await fakeCp(t, {
    gate: liveGate,
    presence: { ...livePresence(), reportedAt: new Date(Date.now() + 120_000).toISOString() },
  })
  const future = await import('../src/lib/rooms.ts?cp-future')
  assert.equal((await future.currentRooms()).available, false)
})

test('fresh malformed room reports are unavailable', async (t) => {
  await fakeCp(t, { gate: liveGate, presence: livePresence({ rooms: [{ ...room, players: -1 }] }) })
  const invalid = await import('../src/lib/rooms.ts?cp-invalid')
  assert.equal((await invalid.currentRooms()).available, false)
})
