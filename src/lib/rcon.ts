import net from 'node:net'

const AUTH = 3,
  COMMAND = 2
const MAX_PACKET_LENGTH = 65_536
const MAX_RESPONSE_BYTES = 1_048_576
// An idle pooled connection is closed after this long; the next call reconnects.
const IDLE_CLOSE_MS = 30_000

function packet(id: number, type: number, body: string): Buffer {
  const text = Buffer.from(body, 'utf8'),
    frame = Buffer.alloc(14 + text.length)
  frame.writeInt32LE(10 + text.length, 0)
  frame.writeInt32LE(id, 4)
  frame.writeInt32LE(type, 8)
  text.copy(frame, 12)
  return frame
}

type RconOptions = { host: string; port: number; password: string; timeout?: number }

function connectSocket(host: string, port: number, timeout: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('RCON timeout'))
    }, timeout)
    const onError = (error: Error) => {
      clearTimeout(timer)
      reject(error)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve(socket)
    })
  })
}

function readFrames(
  socket: net.Socket,
  timeout: number,
  onPacket: (id: number, type: number) => boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0),
      done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('RCON timeout')), timeout)
    const onError = (error: Error) => finish(error)
    const onClose = () => finish(new Error('RCON connection closed'))
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk])
      if (data.length > MAX_RESPONSE_BYTES) return finish(new Error('RCON response too large'))
      while (data.length >= 4) {
        const length = data.readInt32LE(0)
        if (length < 10 || length > MAX_PACKET_LENGTH)
          return finish(new Error('Invalid RCON packet'))
        if (data.length < length + 4) return
        const id = data.readInt32LE(4),
          type = data.readInt32LE(8)
        data = data.subarray(length + 4)
        if (id === -1) return finish(new Error('RCON authentication failed'))
        if (onPacket(id, type)) return finish()
      }
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

function authenticate(socket: net.Socket, password: string, timeout: number): Promise<void> {
  const wait = readFrames(socket, timeout, (id, type) => {
    // Source servers may send an empty value packet before the auth reply; only the auth reply (type 2, id 1) starts commands.
    if (type === COMMAND && id === 1) return true
  })
  socket.write(packet(1, AUTH, password))
  return wait
}

/**
 * Source RCON command runner on an authenticated connection: commands run in order,
 * one output per command. Framing is the vanilla contract (rcon docs above): one
 * packet per write, an empty sentinel packet after each first reply whose
 * "Unknown request …" reply ends that command output. The socket stays open for
 * the caller (one-shot closes it, the pool keeps it); per-command caps are per
 * command, not per connection.
 */
function execCommands(
  socket: net.Socket,
  commands: string[],
  timeout: number,
  onCommandDone?: () => void,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const outputs: string[] = []
    let data = Buffer.alloc(0),
      step = 0,
      currentChunks: Buffer[] = [],
      currentBytes = 0,
      sentinel = false,
      done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (error) reject(error)
      else resolve(outputs)
    }
    const timer = setTimeout(() => finish(new Error('RCON timeout')), timeout)
    const onError = (error: Error) => finish(error)
    const onClose = () => finish(new Error('RCON connection closed'))
    const send = () => {
      if (step >= commands.length) return finish()
      currentChunks = []
      currentBytes = 0
      sentinel = false
      socket.write(packet(10 + step * 2, COMMAND, commands[step]))
    }
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk])
      if (data.length > MAX_RESPONSE_BYTES) return finish(new Error('RCON response too large'))
      while (data.length >= 4) {
        const length = data.readInt32LE(0)
        if (length < 10 || length > MAX_PACKET_LENGTH)
          return finish(new Error('Invalid RCON packet'))
        if (data.length < length + 4) return
        const id = data.readInt32LE(4),
          bodyBuffer = data.subarray(12, length + 2)
        data = data.subarray(length + 4)
        if (id === -1) return finish(new Error('RCON authentication failed'))
        if (id === 10 + step * 2) {
          currentBytes += bodyBuffer.length
          // Per-command cap: every command gets its own megabyte. The outputs array holds
          // one entry per command by contract, so a connection-wide total would reject a
          // second large reply while each reply on its own is fine.
          if (currentBytes > MAX_RESPONSE_BYTES) return finish(new Error('RCON response too large'))
          currentChunks.push(Buffer.from(bodyBuffer))
          if (!sentinel) {
            sentinel = true
            socket.write(packet(11 + step * 2, 100, ''))
          }
        } else if (id === 11 + step * 2) {
          outputs.push(Buffer.concat(currentChunks).toString('utf8'))
          currentChunks = []
          currentBytes = 0
          step++
          onCommandDone?.()
          send()
        }
      }
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    send()
  })
}

/**
 * Source RCON over one connection: authenticate, run commands in order, return one output per command.
 * Minecraft splits long output into several packets and never marks the last one, so after the first reply
 * packet an empty packet of an unknown type is sent; its reply ("Unknown request …") ends that command output.
 * Vanilla RCON reads one packet per socket read and drops the connection otherwise: never write two packets at once.
 */
export function rcon(
  commands: string[],
  { host, port, password, timeout = 5000 }: RconOptions,
): Promise<string[]> {
  let socket: net.Socket | null = null
  return (async () => {
    socket = await connectSocket(host, port, timeout)
    await authenticate(socket, password, timeout)
    return execCommands(socket, commands, timeout)
  })().finally(() => socket?.destroy())
}

type PoolEntry = { socket: net.Socket | null; tail: Promise<unknown>; idle: NodeJS.Timeout | null }
const pools = new Map<string, PoolEntry>()

/** Drop every pooled connection: tests and one-off scripts; the long-lived server relies on idle close. */
export function closeRconPools(): void {
  for (const entry of pools.values()) {
    if (entry.idle) clearTimeout(entry.idle)
    entry.socket?.destroy()
  }
  pools.clear()
}

/**
 * The same RCON call over one authenticated connection per target, reused across
 * calls: no TCP+auth handshake per admin action. Calls on one target serialize
 * through a chain (vanilla drops multi-packet writes), a dead connection is
 * dropped and reconnected, an idle one is closed. A connection-level failure
 * before the first command reply retries once on a fresh connection; anything
 * later is an unknown outcome and surfaces, never retried.
 */
export function rconReuse(commands: string[], options: RconOptions): Promise<string[]> {
  const key = `${options.host}:${options.port}:${options.password}`
  let entry = pools.get(key)
  if (!entry) {
    entry = { socket: null, tail: Promise.resolve(), idle: null }
    pools.set(key, entry)
  }
  const current = entry
  const run = current.tail.catch(() => {}).then(() => execPooled(current, commands, options))
  current.tail = run.catch(() => {})
  return run
}

/** Pool a socket: a persistent error listener keeps an idle connection's reset from
crashing the process (an unhandled socket 'error' is fatal in Node) and drops it. */
function adopt(entry: PoolEntry, socket: net.Socket): net.Socket {
  // Only destroy: an in-flight execCommands handles its own error, and the next call
  // replaces a destroyed socket, so the entry is never cleared from under a caller.
  socket.on('error', () => socket.destroy())
  entry.socket = socket
  return socket
}

async function execPooled(
  entry: PoolEntry,
  commands: string[],
  { host, port, password, timeout = 5000 }: RconOptions,
): Promise<string[]> {
  if (entry.idle) {
    clearTimeout(entry.idle)
    entry.idle = null
  }
  try {
    if (!entry.socket || entry.socket.destroyed) {
      entry.socket?.destroy()
      entry.socket = null
      const socket = await connectSocket(host, port, timeout)
      try {
        await authenticate(socket, password, timeout)
      } catch (error) {
        socket.destroy()
        throw error
      }
      adopt(entry, socket)
    }
    let completed = 0
    try {
      return await execCommands(entry.socket, commands, timeout, () => completed++)
    } catch (error) {
      entry.socket?.destroy()
      entry.socket = null
      if (
        completed === 0 &&
        /connection closed|ECONN|socket hang up/.test((error as Error).message)
      ) {
        const socket = await connectSocket(host, port, timeout)
        try {
          await authenticate(socket, password, timeout)
          adopt(entry, socket)
          return await execCommands(socket, commands, timeout)
        } catch (retryError) {
          entry.socket?.destroy()
          entry.socket = null
          throw retryError
        }
      }
      throw error
    }
  } finally {
    if (entry.socket && !entry.socket.destroyed) {
      entry.idle = setTimeout(() => {
        entry.socket?.destroy()
        entry.socket = null
      }, IDLE_CLOSE_MS)
      entry.idle.unref?.()
    }
  }
}
