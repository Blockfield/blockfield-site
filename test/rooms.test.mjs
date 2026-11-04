import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRooms, varint, readVarint, queryRooms } from '../src/lib/rooms.ts'
const room = {
  id: '12345678-1234-1234-1234-123456789abc',
  name: 'Комната 1',
  mode: 'Захват точек',
  map: 'Карта',
  phase: 'GAME',
  players: 4,
  joinable: true,
}
test('room snapshots distinguish empty, stale and malformed responses', () => {
  assert.deepEqual(parseRooms({ checkedAt: Date.now(), rooms: [] }).rooms, [])
  assert.throws(() => parseRooms({ checkedAt: Date.now() - 60000, rooms: [room] }))
  for (const invalid of [
    { ...room, id: '../file' },
    { ...room, players: -1 },
    { ...room, phase: 'unknown' },
  ])
    assert.throws(() => parseRooms({ checkedAt: Date.now(), rooms: [invalid] }))
})
test('varints support fragments and reject overlong input', () => {
  for (const value of [0, 127, 128, 767, 1048576]) assert.equal(readVarint(varint(value))[0], value)
  assert.equal(readVarint(Buffer.from([128])), null)
  assert.throws(() => readVarint(Buffer.from([128, 128, 128, 128, 128])))
})
test('Minecraft status accepts fragmented replies and closes its connection', async () => {
  const server = net.createServer((socket) =>
    socket.once('data', () => {
      const json = Buffer.from(
        JSON.stringify({ blockfield: { checkedAt: Date.now(), rooms: [room] } }),
      )
      const packet = Buffer.concat([Buffer.from([0]), varint(json.length), json])
      const frame = Buffer.concat([varint(packet.length), packet])
      socket.write(frame.subarray(0, 1))
      setTimeout(() => socket.end(frame.subarray(1)), 10)
    }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    assert.deepEqual((await queryRooms('127.0.0.1', server.address().port)).rooms, [room])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
test('restarting game server behind the proxy reports an open lobby', async () => {
  const lobby = net.createServer((socket) =>
    socket.once('data', () => {
      const json = Buffer.from(JSON.stringify({ version: { name: 'Velocity' } }))
      const packet = Buffer.concat([Buffer.from([0]), varint(json.length), json])
      socket.end(Buffer.concat([varint(packet.length), packet]))
    }),
  )
  await new Promise((resolve) => lobby.listen(0, '127.0.0.1', resolve))
  Object.assign(process.env, {
    BLOCKFIELD_SERVER_HOST: '127.0.0.1',
    BLOCKFIELD_SERVER_PORT: '1',
    BLOCKFIELD_LOBBY_HOST: '127.0.0.1',
    BLOCKFIELD_LOBBY_PORT: String(lobby.address().port),
  })
  try {
    const { currentRooms } = await import('../src/lib/rooms.ts?lobby')
    const status = await currentRooms()
    assert.equal(status.available, false)
    assert.equal(status.lobby, true)
  } finally {
    await new Promise((resolve) => lobby.close(resolve))
  }
})
test('battle data preserves capture state and rejects invalid progress and scores', () => {
  const battle = {
    red: 720,
    blue: 685,
    points: [
      { id: 'a', name: 'A', owner: 'BLUE', claiming: 'NONE', capturing: 'RED', progress: 35 },
    ],
  }
  const parse = (value) =>
    parseRooms({ checkedAt: Date.now(), rooms: [{ ...room, battle: value }] })
  assert.deepEqual(parse(battle).rooms[0].battle, battle)
  assert.throws(() => parse({ ...battle, red: -1 }))
  assert.throws(() => parse({ ...battle, points: [{ ...battle.points[0], progress: 101 }] }))
  assert.throws(() => parse({ ...battle, points: [{ ...battle.points[0], owner: 'unknown' }] }))
})
const statusServer = (json, onConnect = () => {}) =>
  net.createServer((socket) => {
    onConnect()
    socket.once('data', () => {
      const body = Buffer.from(JSON.stringify(json))
      const packet = Buffer.concat([Buffer.from([0]), varint(body.length), body])
      socket.end(Buffer.concat([varint(packet.length), packet]))
    })
  })
test('parseRooms tolerates blockfield-mod#28 status fields and drops top-level maintenance', () => {
  const ranked = {
    ...room,
    phase: 'PREPARING',
    joinable: false,
    capacity: 10,
    format: 'ranked',
    admission: 'waiting',
    round: 2,
    front: { index: 1, length: 3 },
    ready: { ready: 3, required: 4 },
    reserved: 1,
  }
  const status = parseRooms({
    checkedAt: Date.now(),
    maintenance: 'DRAINING',
    rooms: [{ ...room, capacity: 10, format: 'casual', admission: 'open' }, ranked],
  })
  assert.equal(status.rooms.length, 2)
  assert.equal('maintenance' in status, false)
})
test('parseRooms passes a release tag or short-SHA build through', () => {
  assert.equal(parseRooms({ checkedAt: Date.now(), build: 'v2.31.6', rooms: [] }).build, 'v2.31.6')
  for (const build of ['abc1234', '1'.repeat(7), '1'.repeat(40)])
    assert.equal(parseRooms({ checkedAt: Date.now(), build, rooms: [] }).build, build)
  for (const build of [
    'latest',
    '<b>v1</b>',
    7,
    null,
    'xyz',
    'ABC1234',
    '1'.repeat(6),
    '1'.repeat(41),
  ])
    assert.equal('build' in parseRooms({ checkedAt: Date.now(), build, rooms: [] }), false)
})
test('gate values fail closed with a bounded message', async () => {
  const { maintenanceFrom, readGate, maintenanceMessage } = await import('../src/lib/rooms.ts')
  assert.equal(maintenanceFrom({ mode: 'game', message: 'x', since: 1 }), null)
  assert.equal(
    maintenanceFrom({
      mode: 'game',
      workshop: { mode: 'maintenance', message: 'Мастерская перезапускается' },
    }),
    null,
    'Workshop unavailability never closes Game',
  )
  assert.deepEqual(
    maintenanceFrom({
      mode: 'maintenance',
      workshop: { mode: 'workshop', message: '' },
    }),
    { message: maintenanceMessage, since: null },
    'Workshop availability cannot reopen Game',
  )
  assert.deepEqual(
    maintenanceFrom({ mode: 'workshop', message: '  Карта  ', since: 5, extra: 1 }),
    { message: 'Карта', since: 5 },
  )
  assert.equal(maintenanceFrom({ mode: 'draining', message: 'x'.repeat(900) }).message.length, 500)
  for (const value of [
    null,
    'game',
    {},
    { mode: 'GAME' },
    { mode: 'unknown', message: 'hi' },
    { mode: 'maintenance', message: ' ' },
  ])
    assert.deepEqual(maintenanceFrom(value), { message: maintenanceMessage, since: null })
  assert.equal(await readGate(undefined), null)
  const dir = await mkdtemp(join(tmpdir(), 'bf-gate-'))
  try {
    const file = join(dir, 'public.json')
    assert.deepEqual(await readGate(file), { message: maintenanceMessage, since: null })
    await writeFile(file, '{"mode":')
    assert.equal((await readGate(file)).message, maintenanceMessage)
    await writeFile(file, JSON.stringify({ mode: 'game', message: 'x'.repeat(20000) }))
    assert.equal((await readGate(file)).message, maintenanceMessage)
    await writeFile(file, JSON.stringify({ mode: 'game', message: '', since: 1 }))
    assert.equal(await readGate(file), null)
  } finally {
    await rm(dir, { recursive: true })
  }
})
test('currentRooms skips the game server unless the gate is in game mode', async () => {
  let queries = 0
  const game = statusServer(
    { blockfield: { checkedAt: Date.now(), rooms: [room] } },
    () => queries++,
  )
  await new Promise((resolve) => game.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(join(tmpdir(), 'bf-gate-'))
  const file = join(dir, 'public.json')
  Object.assign(process.env, {
    BLOCKFIELD_SERVER_HOST: '127.0.0.1',
    BLOCKFIELD_SERVER_PORT: String(game.address().port),
    BLOCKFIELD_LOBBY_HOST: '127.0.0.1',
    BLOCKFIELD_LOBBY_PORT: '1',
  })
  try {
    delete process.env.BLOCKFIELD_GATE_FILE
    assert.deepEqual((await (await import('../src/lib/rooms.ts?unset')).currentRooms()).rooms, [
      room,
    ])
    process.env.BLOCKFIELD_GATE_FILE = file
    await writeFile(file, JSON.stringify({ mode: 'game', message: '', since: 1 }))
    const gameStatus = await (await import('../src/lib/rooms.ts?game')).currentRooms()
    assert.equal(gameStatus.available, true)
    assert.equal('maintenance' in gameStatus, false)
    assert.equal(queries, 2)
    await writeFile(
      file,
      JSON.stringify({
        mode: 'workshop',
        message: 'Редактор карт',
        since: 1757800000000,
        secret: 'x',
      }),
    )
    const workshop = await (await import('../src/lib/rooms.ts?workshop')).currentRooms()
    assert.deepEqual(
      { ...workshop, checkedAt: 0 },
      {
        available: false,
        checkedAt: 0,
        rooms: [],
        maintenance: { message: 'Редактор карт', since: 1757800000000 },
        lobby: false,
      },
    )
    await rm(file)
    const missing = await (await import('../src/lib/rooms.ts?missing')).currentRooms()
    assert.equal(missing.maintenance.since, null)
    assert.equal(queries, 2)
  } finally {
    delete process.env.BLOCKFIELD_GATE_FILE
    await rm(dir, { recursive: true, force: true })
    await new Promise((resolve) => game.close(resolve))
  }
})
test('deployingFromStatus reports controller deploys, never stable or broken status', async () => {
  const { deployingFromStatus } = await import('../src/lib/rooms.ts?deploying')
  for (const phase of ['REQUESTED', 'DRAINING', 'SAVING', 'STARTING'])
    assert.equal(deployingFromStatus({ schema: 1, phase, desired: { profile: 'workshop' } }), true)
  assert.equal(
    deployingFromStatus({
      schema: 1,
      phase: 'game',
      game: { phase: 'STARTING', gate: 'closed', release: null },
    }),
    true,
    'game image rollout with a stable controller phase',
  )
  for (const status of [
    null,
    undefined,
    {},
    { phase: 'game', game: { phase: 'game', gate: 'public', release: 'v1.2.3' } },
    {
      phase: 'ERROR',
      game: { phase: 'STARTING', gate: 'closed', release: null },
    },
    { phase: 'sleeping' },
    { phase: 5 },
    { phase: null, game: { phase: 'STARTING' } },
  ])
    assert.equal(deployingFromStatus(status), false)
})
test('game down mid-deploy serves deploying with last-known rooms', async () => {
  const game = statusServer({ blockfield: { checkedAt: Date.now(), rooms: [room] } })
  await new Promise((resolve) => game.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(join(tmpdir(), 'bf-controller-'))
  const statusFile = join(dir, 'status.json')
  await writeFile(
    statusFile,
    JSON.stringify({
      schema: 1,
      revision: 1,
      phase: 'game',
      game: { phase: 'game', gate: 'public', release: 'v1.2.3' },
    }),
  )
  delete process.env.BLOCKFIELD_GATE_FILE
  Object.assign(process.env, {
    BLOCKFIELD_SERVER_HOST: '127.0.0.1',
    BLOCKFIELD_SERVER_PORT: String(game.address().port),
    BLOCKFIELD_LOBBY_HOST: '127.0.0.1',
    BLOCKFIELD_LOBBY_PORT: '1',
    BLOCKFIELD_ADMIN_DIR: dir,
  })
  try {
    const { currentRooms } = await import('../src/lib/rooms.ts?deploy-fallback')
    assert.deepEqual((await currentRooms()).rooms, [room])
    await new Promise((resolve) => game.close(resolve))
    await writeFile(
      statusFile,
      JSON.stringify({
        schema: 1,
        revision: 2,
        phase: 'STARTING',
        desired: { profile: 'game' },
        game: { phase: 'STARTING', gate: 'closed', release: null },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 5100))
    const status = await currentRooms()
    assert.equal(status.available, false)
    assert.equal(status.deploying, true)
    assert.equal(status.stale, true)
    assert.deepEqual(status.rooms, [room])
  } finally {
    delete process.env.BLOCKFIELD_ADMIN_DIR
    await rm(dir, { recursive: true, force: true })
    if (game.listening) await new Promise((resolve) => game.close(resolve))
  }
})
test('game down with no deploy stays bare unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-controller-'))
  await writeFile(
    join(dir, 'status.json'),
    JSON.stringify({
      schema: 1,
      revision: 1,
      phase: 'game',
      game: { phase: 'game', gate: 'public', release: 'v1.2.3' },
    }),
  )
  delete process.env.BLOCKFIELD_GATE_FILE
  Object.assign(process.env, {
    BLOCKFIELD_SERVER_HOST: '127.0.0.1',
    BLOCKFIELD_SERVER_PORT: '1',
    BLOCKFIELD_LOBBY_HOST: '127.0.0.1',
    BLOCKFIELD_LOBBY_PORT: '1',
    BLOCKFIELD_ADMIN_DIR: dir,
  })
  try {
    const { currentRooms } = await import('../src/lib/rooms.ts?deploy-dead')
    const status = await currentRooms()
    assert.equal(status.available, false)
    assert.deepEqual(status.rooms, [])
    assert.equal('deploying' in status, false)
    assert.equal('stale' in status, false)
  } finally {
    delete process.env.BLOCKFIELD_ADMIN_DIR
    await rm(dir, { recursive: true, force: true })
  }
})
test('running version comes from the controller, live status only fills the gap', async () => {
  const game = statusServer({ blockfield: { checkedAt: Date.now(), build: 'v1.2.3', rooms: [] } })
  await new Promise((resolve) => game.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(join(tmpdir(), 'bf-controller-'))
  const statusFile = join(dir, 'status.json')
  await writeFile(
    statusFile,
    JSON.stringify({
      schema: 1,
      revision: 1,
      phase: 'game',
      game: { phase: 'game', gate: 'public', release: 'v9.9.9' },
    }),
  )
  delete process.env.BLOCKFIELD_GATE_FILE
  Object.assign(process.env, {
    BLOCKFIELD_SERVER_HOST: '127.0.0.1',
    BLOCKFIELD_SERVER_PORT: String(game.address().port),
    BLOCKFIELD_LOBBY_HOST: '127.0.0.1',
    BLOCKFIELD_LOBBY_PORT: '1',
    BLOCKFIELD_ADMIN_DIR: dir,
  })
  try {
    const first = await import('../src/lib/rooms.ts?deploy-build')
    assert.equal((await first.currentRooms()).build, 'v9.9.9')
    await writeFile(
      statusFile,
      JSON.stringify({
        schema: 1,
        revision: 2,
        phase: 'game',
        game: { phase: 'game', gate: 'public', release: 'latest' },
      }),
    )
    const second = await import('../src/lib/rooms.ts?deploy-build-fallback')
    assert.equal((await second.currentRooms()).build, 'v1.2.3')
  } finally {
    delete process.env.BLOCKFIELD_ADMIN_DIR
    await rm(dir, { recursive: true, force: true })
    if (game.listening) await new Promise((resolve) => game.close(resolve))
  }
})
