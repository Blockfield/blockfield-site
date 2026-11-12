import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { rcon, rconReuse, closeRconPools } from '../src/lib/rcon.ts'

const frame = (id, type, body) => {
  const text = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const out = Buffer.alloc(14 + text.length)
  out.writeInt32LE(10 + text.length, 0)
  out.writeInt32LE(id, 4)
  out.writeInt32LE(type, 8)
  text.copy(out, 12)
  return out
}

// Behaves like vanilla Minecraft: one packet per read (a read with more than one packet drops the connection),
// auth reply type 2, long output split in 4 KiB chunks, "Unknown request" for other types.
function fakeServer(t, { password = 'secret', silent = false } = {}) {
  const seen = []
  const stats = { connections: 0, auths: 0 }
  const server = net.createServer((socket) => {
    stats.connections++
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      {
        if (chunk.length < 4 || chunk.length !== chunk.readInt32LE(0) + 4) {
          socket.destroy()
          return
        }
        const length = chunk.readInt32LE(0),
          id = chunk.readInt32LE(4),
          type = chunk.readInt32LE(8),
          body = chunk.subarray(12, length + 2).toString()
        if (silent) return
        if (type === 3) {
          stats.auths++
          socket.write(frame(body === password ? id : -1, 2, ''))
        } else if (type === 2) {
          seen.push(body)
          if (body === 'hang') return // Silent: emits no response packet at all
          if (body === 'empty') {
            socket.write(frame(id, 0, ''))
            return
          }
          if (body === 'segmented-oversized') {
            // 300 packets of 4000 bytes = ~1.2 MiB total; individual packets and unconsumed buffer are tiny
            const chunkData = 'A'.repeat(4000)
            for (let i = 0; i < 300; i++) socket.write(frame(id, 0, chunkData))
            return
          }
          if (body === 'split-utf8') {
            const fullBuf = Buffer.from('Привет, мир! 🛡️', 'utf8')
            // Split in the middle of a 2-byte Cyrillic character (at byte 5)
            const part1 = fullBuf.subarray(0, 5)
            const part2 = fullBuf.subarray(5)
            socket.write(frame(id, 0, part1))
            socket.write(frame(id, 0, part2))
            return
          }
          const output = body === 'big' ? 'x'.repeat(9000) : `ran ${body}`
          for (let i = 0; i < output.length; i += 4096)
            socket.write(frame(id, 0, output.slice(i, i + 4096)))
        } else socket.write(frame(id, 0, `Unknown request ${type.toString(16)}`))
      }
    })
  })
  t.after(() => server.close())
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, stats })),
  )
}

test('RCON authenticates, runs commands in order and joins multi-packet output', async (t) => {
  const { port, seen } = await fakeServer(t)
  const outputs = await rcon(['list', 'big', 'say hi'], {
    host: '127.0.0.1',
    port,
    password: 'secret',
  })
  assert.deepEqual(seen, ['list', 'big', 'say hi'])
  assert.equal(outputs[0], 'ran list')
  assert.equal(outputs[1].length, 9000)
  assert.equal(outputs[2], 'ran say hi')
  assert.ok(
    !outputs.join('').includes('Unknown request'),
    'the sentinel reply is not part of the output',
  )
})

test('RCON empty response packet is handled by sentinel and returns empty output', async (t) => {
  const { port, seen } = await fakeServer(t)
  const outputs = await rcon(['empty'], {
    host: '127.0.0.1',
    port,
    password: 'secret',
  })
  assert.deepEqual(seen, ['empty'])
  assert.deepEqual(outputs, [''])
})

test('RCON command emitting NO response packets times out honestly without guessing empty output', async (t) => {
  const { port, seen } = await fakeServer(t)
  await assert.rejects(
    rcon(['hang'], { host: '127.0.0.1', port, password: 'secret', timeout: 150 }),
    /timeout/,
  )
  assert.deepEqual(seen, ['hang'])
})

test('RCON joins segmented multi-packet UTF-8 output without replacement character corruption', async (t) => {
  const { port } = await fakeServer(t)
  const outputs = await rcon(['split-utf8'], {
    host: '127.0.0.1',
    port,
    password: 'secret',
  })
  assert.equal(outputs[0], 'Привет, мир! 🛡️')
  assert.ok(!outputs[0].includes('�'), 'no replacement character from split UTF-8 bytes')
})

test('RCON response cap is per command: many small replies in one batch all succeed', async (t) => {
  const { port } = await fakeServer(t)
  // 150 replies of 9000 bytes: ~1.3 MiB in total, every reply far below the cap.
  // A connection-wide total would reject the batch around the 117th command.
  const commands = Array(150).fill('big')
  const outputs = await rcon(commands, {
    host: 'localhost',
    port,
    password: 'secret',
    timeout: 15000,
  })
  assert.equal(outputs.length, 150)
  assert.ok(outputs.every((output) => output.length === 9000))
})

test('RCON wrong password fails without running commands', async (t) => {
  const { port, seen } = await fakeServer(t)
  await assert.rejects(
    rcon(['stop'], { host: '127.0.0.1', port, password: 'wrong' }),
    /authentication failed/,
  )
  assert.deepEqual(seen, [])
})

test('RCON silent server times out', async (t) => {
  const { port } = await fakeServer(t, { silent: true })
  await assert.rejects(
    rcon(['list'], { host: '127.0.0.1', port, password: 'secret', timeout: 200 }),
    /timeout/,
  )
})
test('RCON cumulative response limit rejects many segmented packets exceeding 1 MiB', async (t) => {
  const { port } = await fakeServer(t)
  await assert.rejects(
    rcon(['segmented-oversized'], {
      host: '127.0.0.1',
      port,
      password: 'secret',
      timeout: 1000,
    }),
    /response too large/,
  )
})

test('RCON reuse: sequential and concurrent calls share one authenticated connection', async (t) => {
  const { port, seen, stats } = await fakeServer(t)
  t.after(() => closeRconPools())
  const opts = { host: '127.0.0.1', port, password: 'secret' }
  assert.deepEqual(await rconReuse(['list'], opts), ['ran list'])
  assert.deepEqual(await rconReuse(['say hi'], opts), ['ran say hi'])
  assert.deepEqual(
    (await Promise.all([1, 2, 3, 4].map((i) => rconReuse([`c${i}`], opts)))).map((out) => out[0]),
    ['ran c1', 'ran c2', 'ran c3', 'ran c4'],
  )
  // Interrupt shape: two commands, same connection, no extra auth.
  assert.deepEqual(
    await rconReuse(['bf maintenance interrupt', 'bf maintenance interrupt confirm x'], opts),
    ['ran bf maintenance interrupt', 'ran bf maintenance interrupt confirm x'],
  )
  assert.deepEqual(seen, [
    'list',
    'say hi',
    'c1',
    'c2',
    'c3',
    'c4',
    'bf maintenance interrupt',
    'bf maintenance interrupt confirm x',
  ])
  assert.equal(stats.connections, 1)
  assert.equal(stats.auths, 1)
})

test('RCON reuse reconnects after the server drops the pooled connection', async (t) => {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (chunk) => {
      const id = chunk.readInt32LE(4),
        type = chunk.readInt32LE(8),
        body = chunk.subarray(12, chunk.readInt32LE(0) + 2).toString()
      if (type === 3) socket.write(frame(id, 2, ''))
      else if (type === 2) socket.write(frame(id, 0, `ran ${body}`))
      else socket.write(frame(id, 0, 'Unknown request'))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => server.close())
  t.after(() => closeRconPools())
  const opts = { host: '127.0.0.1', port, password: 'secret' }
  assert.deepEqual(await rconReuse(['list'], opts), ['ran list'])
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(await rconReuse(['list'], opts), ['ran list'])
})

test('RCON reuse survives a reset on the idle pooled connection', async (t) => {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (chunk) => {
      const id = chunk.readInt32LE(4),
        type = chunk.readInt32LE(8),
        body = chunk.subarray(12, chunk.readInt32LE(0) + 2).toString()
      if (type === 3) socket.write(frame(id, 2, ''))
      else socket.write(frame(id, 0, `ran ${body}`))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => server.close())
  t.after(() => closeRconPools())
  const opts = { host: '127.0.0.1', port, password: 'secret' }
  let uncaught = null
  const onUncaught = (error) => (uncaught = error)
  process.prependListener('uncaughtException', onUncaught)
  t.after(() => process.removeListener('uncaughtException', onUncaught))
  assert.deepEqual(await rconReuse(['list'], opts), ['ran list'])
  // RST while the pooled socket sits idle: ECONNRESET must not escape as an uncaught error.
  for (const socket of sockets) socket.resetAndDestroy()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(uncaught, null)
  assert.deepEqual(await rconReuse(['list'], opts), ['ran list'])
})

test('RCON reuse retries once when the pooled connection resets mid-command', async (t) => {
  let resets = 0
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      const id = chunk.readInt32LE(4),
        type = chunk.readInt32LE(8),
        body = chunk.subarray(12, chunk.readInt32LE(0) + 2).toString()
      if (type === 3) return void socket.write(frame(id, 2, ''))
      if (body === 'flaky' && resets++ === 0) return void socket.resetAndDestroy()
      socket.write(frame(id, 0, `ran ${body}`))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => server.close())
  t.after(() => closeRconPools())
  const opts = { host: '127.0.0.1', port, password: 'secret' }
  assert.deepEqual(await rconReuse(['list'], opts), ['ran list'])
  assert.deepEqual(await rconReuse(['flaky'], opts), ['ran flaky'])
  assert.deepEqual(await rconReuse(['list'], opts), ['ran list'])
})
