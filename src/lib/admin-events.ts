import { randomUUID } from 'node:crypto'
import { can, overviewSnapshot, readSettingsCpView, type Actor, type Role } from './admin.ts'
import {
  cpWorkshopReadConfigured,
  openWorkshopStateEventsCp,
  parseSseStream,
  readWorkshopSnapshotCp,
  readWorkshopStateCp,
} from './cp.ts'
import { cachedRooms } from './rooms.ts'

export type AdminEvent = {
  type: 'status' | 'rooms' | 'settings' | 'audit' | 'presence' | 'request'
  at: number
  [key: string]: any
}
type Send = (event: AdminEvent, id?: string) => void
const subscribers = new Set<Subscriber>()
// A bounded, process-local history covers brief reconnects without retaining an unbounded audit copy.
const history: { id: string; event: AdminEvent; cpSeq?: number }[] = []
const epoch = randomUUID()
let sequence = 0
const presence = new Map<string, Actor & { tab: string; at: number }>()
const streams = new Map<string, number>()
let roomsTimer: ReturnType<typeof setInterval> | undefined
let retryTimer: ReturnType<typeof setInterval> | undefined
let presenceTimer: ReturnType<typeof setInterval> | undefined
let roomsJson = ''
let cpAbort: AbortController | undefined
let settingsTimer: ReturnType<typeof setInterval> | undefined
let settingsJson = ''
let catalogJson = ''
let settingsCpRevisions: Record<string, number> = {}
async function pollSettingsCp() {
  if (!subscribers.size) return
  try {
    const view = await readSettingsCpView()
    const cp = await import('./cp.ts')
    const presence = await cp.readPresenceCp().catch(() => null)
    const catalogs = JSON.stringify([
      (presence?.presence as any)?.gunCatalog,
      (presence?.presence as any)?.kitCatalog,
    ])
    const catalogsChanged = catalogs !== catalogJson
    const json = JSON.stringify({ settings: view.settings, applied: view.applied })
    if (json === settingsJson && !catalogsChanged) return
    catalogJson = catalogs
    const previous = settingsCpRevisions
    settingsCpRevisions = view.cpRevisions ?? {}
    settingsJson = json
    publish({
      type: 'settings',
      settings: view.settings,
      applied: view.applied,
      cpRevisions: view.cpRevisions,
      ...(catalogsChanged || previous.gunBalance !== settingsCpRevisions.gunBalance
        ? { gunBalance: true }
        : {}),
      ...(catalogsChanged || previous.kits !== settingsCpRevisions.kits ? { kits: true } : {}),
    })
  } catch {
    // Keep the last published snapshot until the next poll.
  }
}
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
  reconcilePendingRequests()
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
export function publish(
  input: Omit<AdminEvent, 'at'> & { type: AdminEvent['type']; at?: number },
  cpSeq?: number,
) {
  const event: AdminEvent = { ...input, at: input.at ?? Date.now() }
  const id = `${epoch}:${++sequence}`
  history.push({ id, event, cpSeq })
  if (history.length > 200) history.shift()
  for (const subscriber of subscribers) deliver(subscriber, event, id, cpSeq)
  return id
}
type Subscriber = {
  filter: (event: AdminEvent) => boolean
  send: Send
  statusCount: number
  cpSeq: number
}
function deliver(subscriber: Subscriber, event: AdminEvent, id?: string, cpSeq?: number) {
  if (!subscribers.has(subscriber) || !subscriber.filter(event)) return
  try {
    if (event.type === 'status') {
      if (cpSeq !== undefined && cpSeq < subscriber.cpSeq) return
      if (cpSeq !== undefined) subscriber.cpSeq = cpSeq
      subscriber.statusCount++
    }
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

function publishResult(id: string, value: unknown, seq?: number) {
  if (!subscribers.size || value === null || value === undefined) return
  pendingRequests.delete(id)
  const knownSeq = publishedResults.get(id)
  if (knownSeq !== undefined && (seq === undefined || seq <= knownSeq)) return
  publishedResults.delete(id)
  publishedResults.set(id, seq ?? 0)
  if (publishedResults.size > 500) {
    publishedResults.delete(publishedResults.keys().next().value!)
  }
  publish({
    type: 'request',
    id,
    result: redactKeyResult(value),
  })
}

function reconcilePendingRequests() {
  if (!subscribers.size || !cpWorkshopReadConfigured() || !pendingRequests.size) return
  const names = [...pendingRequests.keys()].map((id) => `result:${id}`)
  void readWorkshopStateCp(names)
    .then((docs) => {
      for (const [name, doc] of Object.entries(docs)) {
        if (name.startsWith('result:') && pendingRequests.has(name.slice(7)))
          publishResult(name.slice(7), doc?.value, doc?.seq)
      }
    })
    .catch(() => {})
}

async function consumeWorkshopEvents(signal: AbortSignal) {
  let lastSeq: number | null = null
  let prevSeq: number | null = null
  let needsSnapshot = false
  let liveStatus: unknown
  let liveSession: unknown
  let consecutiveResyncs = 0

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
        const snapshot = await readWorkshopSnapshotCp([...WORKSHOP_STATE_NAMES], {
          signal: attempt.signal,
        })
        const resultNames = [...pendingRequests.keys()].map((id) => `result:${id}`)
        const results = resultNames.length
          ? await readWorkshopStateCp(resultNames, { signal: attempt.signal })
          : {}
        if (signal.aborted) return
        const docs = { ...snapshot.documents, ...results }
        liveStatus = docs.status?.value ?? null
        liveSession = docs.session?.value ?? null
        if (needsSnapshot && !signal.aborted && subscribers.size) {
          const overview = await overviewSnapshot({ status: liveStatus, session: liveSession })
          if (!signal.aborted && subscribers.size)
            publish({ type: 'status', ...overview }, snapshot.seq)
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
        lastSeq = snapshot.seq
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
          throw new Error('invalid workshop state event')
        }
        const name = record?.name
        if (!Number.isSafeInteger(record?.seq) || typeof name !== 'string')
          throw new Error('invalid workshop state event')
        if (record.seq <= (lastSeq ?? 0)) return
        if (name === 'status') liveStatus = record.value ?? null
        else if (name === 'session') liveSession = record.value ?? null
        if (['status', 'session', 'members', 'candidates', 'maps'].includes(name)) {
          if (!signal.aborted && subscribers.size) {
            const snapshot = await overviewSnapshot({ status: liveStatus, session: liveSession })
            if (!signal.aborted && subscribers.size)
              publish({ type: 'status', ...snapshot }, record.seq)
          }
        } else if (name.startsWith('result:')) {
          publishResult(name.slice('result:'.length), record.value, record.seq)
        }
        lastSeq = record.seq
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
  settingsJson = ''
  catalogJson = ''
  settingsCpRevisions = {}
  void pollSettingsCp()
  settingsTimer = setInterval(() => void pollSettingsCp(), 5000)
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
    reconcilePendingRequests()
  }, 30_000)
}
function stop() {
  cpAbort?.abort()
  cpAbort = undefined
  clearInterval(roomsTimer)
  clearInterval(settingsTimer)
  clearInterval(presenceTimer)
  clearInterval(retryTimer)
  roomsJson = ''
}
export function subscribe(
  filter: (event: AdminEvent) => boolean,
  send: Send,
  lastEventId?: string,
) {
  const subscriber = { filter, send, statusCount: 0, cpSeq: -1 }
  subscribers.add(subscriber)
  if (subscribers.size === 1) start()
  const statusCount = subscriber.statusCount
  const last = history.findIndex((entry) => entry.id === lastEventId)
  if (last >= 0)
    for (const entry of history.slice(last + 1))
      deliver(subscriber, entry.event, entry.id, entry.cpSeq)
  const initial = (type: AdminEvent['type'], payload: object) =>
    deliver(subscriber, { type, at: Date.now(), ...payload })
  void readSettingsCpView()
    .then((view) => initial('settings', { ...view, gunBalance: true, kits: true }))
    .catch(() => {})
  initial('presence', { presence: presenceList() })
  void (async () => {
    if (!cpWorkshopReadConfigured()) return { snapshot: await overviewSnapshot(), cpSeq: undefined }
    const state = await readWorkshopSnapshotCp(['status', 'session'])
    const snapshot = await overviewSnapshot({
      status: state.documents.status?.value ?? null,
      session: state.documents.session?.value ?? null,
    })
    return { snapshot, cpSeq: state.seq }
  })()
    .then(({ snapshot, cpSeq }) => {
      if (cpSeq !== undefined || subscriber.statusCount === statusCount)
        deliver(subscriber, { type: 'status', at: Date.now(), ...snapshot }, undefined, cpSeq)
    })
    .catch(() => {
      if (subscriber.statusCount === statusCount)
        initial('status', { status: null, session: null, rooms: null })
    })
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
