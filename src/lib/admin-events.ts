import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { can, overviewSnapshot, readSettings, type Actor, type Role } from './admin.ts'
import {
  cpWorkshopReadConfigured,
  openWorkshopStateEventsCp,
  parseSseStream,
  readWorkshopStateCp,
} from './cp.ts'
import { cachedRooms } from './rooms.ts'

export type AdminEvent = {
  type: 'status' | 'rooms' | 'settings' | 'audit' | 'presence' | 'request'
  at: number
  [key: string]: any
}
type Send = (event: AdminEvent, id?: string) => void
const subscribers = new Set<{ filter: (event: AdminEvent) => boolean; send: Send }>()
// A bounded, process-local history covers brief reconnects without retaining an unbounded audit copy.
const history: { id: string; event: AdminEvent }[] = []
const epoch = randomUUID()
let sequence = 0
const presence = new Map<string, Actor & { tab: string; at: number }>()
const streams = new Map<string, number>()
let watchers: FSWatcher[] = []
const debounces = new Map<string, ReturnType<typeof setTimeout>>()
let roomsTimer: ReturnType<typeof setInterval> | undefined
let retryTimer: ReturnType<typeof setInterval> | undefined
const pendingWatches = new Map<string, () => void>()
let presenceTimer: ReturnType<typeof setInterval> | undefined
let roomsJson = ''
const warned = new Set<string>()
let cpAbort: AbortController | undefined
const settingsDir = () => process.env.BLOCKFIELD_SETTINGS_DIR || '/blockfield-admin'
const WORKSHOP_STATE_NAMES = [
  'status',
  'session',
  'members',
  'candidates',
  'maps',
  'ai-keys',
] as const
const PENDING_REQUEST_TTL_MS = 5 * 60_000
const pendingRequests = new Map<string, number>()
const publishedResults = new Map<string, number>()

export function trackWorkshopRequest(id: string, now = Date.now()) {
  if (!id) return
  pendingRequests.delete(id)
  pendingRequests.set(id, now + PENDING_REQUEST_TTL_MS)
  if (pendingRequests.size > 200) {
    pendingRequests.delete(pendingRequests.keys().next().value!)
  }
}

export function eventAllowed(role: Role | null, event: AdminEvent) {
  return can(
    role,
    event.type === 'audit' ? 'audit' : event.type === 'settings' ? 'settings' : 'view',
  )
}
// Key results carry identifying tails any viewer could read off the broadcast
// `request` events or the `view`-gated generic result route. Owners read the full
// result through their own key-status routes; everyone else gets this copy.
export function redactKeyResult(result: any): any {
  if (
    result?.kind !== 'ai-key' &&
    result?.kind !== 'ai-gateway-key' &&
    result?.kind !== 'ai-provider-key'
  )
    return result
  const redacted = { ...result }
  delete redacted.last4
  delete redacted.sha256Prefix
  return redacted
}
export function publish(input: Omit<AdminEvent, 'at'> & { type: AdminEvent['type']; at?: number }) {
  const event: AdminEvent = { ...input, at: input.at ?? Date.now() }
  const id = `${epoch}:${++sequence}`
  history.push({ id, event })
  if (history.length > 200) history.shift()
  for (const subscriber of subscribers) deliver(subscriber, event, id)
  return id
}
type Subscriber = { filter: (event: AdminEvent) => boolean; send: Send }
function deliver(subscriber: Subscriber, event: AdminEvent, id?: string) {
  if (!subscribers.has(subscriber) || !subscriber.filter(event)) return
  try {
    subscriber.send(event, id)
  } catch {
    // A dead stream must not fail the audit write or starve the other subscribers.
    subscribers.delete(subscriber)
    if (!subscribers.size) stop()
  }
}
export function presenceList(now = Date.now()) {
  let changed = false
  for (const [uuid, actor] of presence) {
    if (now - actor.at >= 90_000) {
      presence.delete(uuid)
      changed = true
    }
  }
  const list = [...presence.values()]
  if (changed) publish({ type: 'presence', presence: list })
  return list
}
export function heartbeat(actor: Actor, tab: string) {
  presenceList()
  const previous = presence.get(actor.uuid)
  presence.set(actor.uuid, { ...actor, tab, at: Date.now() })
  const list = [...presence.values()]
  if (
    !previous ||
    previous.tab !== tab ||
    previous.name !== actor.name ||
    previous.role !== actor.role
  )
    publish({ type: 'presence', presence: list })
  return list
}
function warn(directory: string) {
  if (warned.has(directory)) return
  warned.add(directory)
  console.warn(`Admin events: cannot watch ${directory}`)
}
function watchDirectory(directory: string, changed: (name: string) => void) {
  const watchId = watchers.length
  try {
    const watcher = watch(directory, (_, filename) => {
      if (!filename) return
      const name = filename.toString(),
        key = `${watchId}:${join(directory, name)}`
      clearTimeout(debounces.get(key))
      debounces.set(
        key,
        setTimeout(() => {
          debounces.delete(key)
          changed(name)
        }, 150),
      )
    })
    watcher.on('error', () => warn(directory))
    watchers.push(watcher)
    pendingWatches.delete(directory)
  } catch {
    warn(directory)
    pendingWatches.set(directory, () => watchDirectory(directory, changed))
  }
}
function settingsSnapshot(gunBalance = false) {
  return { ...readSettings(settingsDir()), ...(gunBalance ? { gunBalance: true } : {}) }
}
function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function consumeWorkshopEvents(signal: AbortSignal) {
  let lastSeq: number | null = null
  let prevSeq: number | null = null
  let needsSnapshot = false
  let liveStatus: unknown
  let liveSession: unknown
  let consecutiveResyncs = 0

  const publishResult = (id: string, value: unknown, seq?: number) => {
    if (value === null || value === undefined) return
    pendingRequests.delete(id)
    const knownSeq = publishedResults.get(id)
    if (knownSeq !== undefined && (seq === undefined || seq <= knownSeq)) return
    publishedResults.delete(id)
    publishedResults.set(id, seq ?? 0)
    if (publishedResults.size > 500) {
      publishedResults.delete(publishedResults.keys().next().value!)
    }
    if (!signal.aborted && subscribers.size) {
      publish({
        type: 'request',
        id,
        result: redactKeyResult(value),
      })
    }
  }

  while (!signal.aborted && cpWorkshopReadConfigured()) {
    const attempt = new AbortController()
    const onAbort = () => attempt.abort(signal.reason)
    if (signal.aborted) break
    signal.addEventListener('abort', onAbort, { once: true })
    let response: Response | undefined
    let resync = false
    try {
      if (lastSeq === null) {
        const now = Date.now()
        for (const [id, expiresAt] of pendingRequests) {
          if (expiresAt <= now) pendingRequests.delete(id)
        }
        const names = [
          ...WORKSHOP_STATE_NAMES,
          ...[...pendingRequests.keys()].map((id) => `result:${id}`),
        ]
        const docs = await readWorkshopStateCp(names, { signal: attempt.signal })
        let maxSeq = 0
        for (const doc of Object.values(docs)) {
          if (typeof doc?.seq === 'number' && doc.seq > maxSeq) maxSeq = doc.seq
        }
        lastSeq = maxSeq
        liveStatus = docs.status?.value ?? null
        liveSession = docs.session?.value ?? null
        if (needsSnapshot && !signal.aborted && subscribers.size) {
          const snapshot = await overviewSnapshot({ status: liveStatus, session: liveSession })
          if (!signal.aborted && subscribers.size) publish({ type: 'status', ...snapshot })
        }
        for (const [name, doc] of Object.entries(docs)) {
          if (!name.startsWith('result:')) continue
          const id = name.slice('result:'.length)
          const isPending = pendingRequests.has(id)
          const isNewer =
            needsSnapshot && (prevSeq === null || typeof doc?.seq !== 'number' || doc.seq > prevSeq)
          if (isPending || isNewer) {
            publishResult(id, doc?.value, typeof doc?.seq === 'number' ? doc.seq : undefined)
          }
        }
        needsSnapshot = false
        prevSeq = null
      }
      response = await openWorkshopStateEventsCp(lastSeq, attempt.signal)
      if (!response.body) throw new Error('empty workshop events body')
      await parseSseStream(response.body, async (ev) => {
        if (attempt.signal.aborted) return
        if (ev.event === 'resync') {
          resync = true
          consecutiveResyncs++
          prevSeq = lastSeq
          lastSeq = null
          needsSnapshot = true
          throw new Error('workshop state resync required')
        }
        if (ev.event !== 'state') return
        consecutiveResyncs = 0
        let record: any
        try {
          record = JSON.parse(ev.data)
        } catch {
          return
        }
        if (typeof record?.seq === 'number' && record.seq > (lastSeq ?? 0)) lastSeq = record.seq
        const name = record?.name
        if (typeof name !== 'string') return
        if (name === 'status') liveStatus = record.value ?? null
        else if (name === 'session') liveSession = record.value ?? null
        if (['status', 'session', 'members', 'candidates', 'maps'].includes(name)) {
          if (!signal.aborted && subscribers.size) {
            const snapshot = await overviewSnapshot({ status: liveStatus, session: liveSession })
            if (!signal.aborted && subscribers.size) publish({ type: 'status', ...snapshot })
          }
          return
        }
        if (name.startsWith('result:')) {
          publishResult(
            name.slice('result:'.length),
            record.value,
            typeof record.seq === 'number' ? record.seq : undefined,
          )
        }
      })
      if (!signal.aborted) {
        needsSnapshot = true
        await delayAbortable(1000, signal)
      }
    } catch {
      if (signal.aborted) return
      if (!resync) needsSnapshot = true
      if (!resync || consecutiveResyncs > 1) await delayAbortable(1000, signal)
    } finally {
      attempt.abort()
      await response?.body?.cancel().catch(() => {})
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function start() {
  // Tests and local development may have no controller or settings exports; idle pages need no watchers or network polls.
  if (cpWorkshopReadConfigured()) {
    cpAbort?.abort()
    cpAbort = new AbortController()
    void consumeWorkshopEvents(cpAbort.signal)
  }
  watchDirectory(settingsDir(), (name) => {
    if (['settings.json', 'applied.json', 'gun-balance.json', 'kits.json'].includes(name))
      publish({
        type: 'settings',
        ...settingsSnapshot(name === 'gun-balance.json'),
        ...(name === 'kits.json' ? { kits: true } : {}),
      })
  })
  roomsTimer = setInterval(() => {
    void cachedRooms().then((rooms) => {
      if (!subscribers.size) return
      const json = JSON.stringify({ ...rooms, checkedAt: 0 })
      if (json !== roomsJson) {
        roomsJson = json
        publish({ type: 'rooms', rooms })
      }
    })
  }, 5000)
  presenceTimer = setInterval(() => presenceList(), 30_000)
  retryTimer = setInterval(() => {
    for (const attempt of [...pendingWatches.values()]) attempt()
  }, 30_000)
}
function stop() {
  cpAbort?.abort()
  cpAbort = undefined
  for (const watcher of watchers) watcher.close()
  watchers = []
  for (const timer of debounces.values()) clearTimeout(timer)
  debounces.clear()
  clearInterval(roomsTimer)
  clearInterval(presenceTimer)
  clearInterval(retryTimer)
  pendingWatches.clear()
  roomsJson = ''
}
export function subscribe(
  filter: (event: AdminEvent) => boolean,
  send: Send,
  lastEventId?: string,
) {
  const subscriber = { filter, send }
  subscribers.add(subscriber)
  if (subscribers.size === 1) start()
  const last = history.findIndex((entry) => entry.id === lastEventId)
  if (last >= 0)
    for (const entry of history.slice(last + 1)) deliver(subscriber, entry.event, entry.id)
  const initial = (type: AdminEvent['type'], payload: object) =>
    deliver(subscriber, { type, at: Date.now(), ...payload })
  initial('settings', settingsSnapshot())
  initial('presence', { presence: presenceList() })
  void overviewSnapshot()
    .then((snapshot) => initial('status', snapshot))
    .catch(() => initial('status', { status: null, session: null, rooms: null }))
  return () => {
    subscribers.delete(subscriber)
    if (!subscribers.size) stop()
  }
}
export function eventStream(
  request: Request,
  actor: Actor,
  currentRole: () => Promise<Role | null> = async () => actor.role,
) {
  let close = () => {}
  let canceled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      const write = (text: string) => {
        // A client that stopped reading would queue frames forever; drop it instead.
        if (controller.desiredSize !== null && controller.desiredSize < -256) return close()
        controller.enqueue(encoder.encode(text))
      }
      streams.set(actor.uuid, (streams.get(actor.uuid) ?? 0) + 1)
      write('retry: 3000\n\n')
      const unsubscribe = subscribe(
        (event) => eventAllowed(actor.role, event),
        (event, id) =>
          write(
            `${id ? `id: ${id}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        request.headers.get('last-event-id') ?? undefined,
      )
      // The filter captured the role at connect time: a demoted admin must stop receiving audit/settings.
      const ping = setInterval(() => {
        write(': ping\n\n')
        void currentRole().then(
          (role) => role !== actor.role && close(),
          () => close(),
        )
      }, 25_000)
      let closed = false
      close = () => {
        if (closed) return
        closed = true
        unsubscribe()
        clearInterval(ping)
        request.signal.removeEventListener('abort', close)
        const remaining = (streams.get(actor.uuid) ?? 1) - 1
        if (remaining) streams.set(actor.uuid, remaining)
        else {
          streams.delete(actor.uuid)
          if (presence.delete(actor.uuid)) publish({ type: 'presence', presence: presenceList() })
        }
        if (!canceled) controller.close()
      }
      request.signal.addEventListener('abort', close, { once: true })
      if (request.signal.aborted) close()
    },
    cancel() {
      canceled = true
      close()
    },
  })
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
