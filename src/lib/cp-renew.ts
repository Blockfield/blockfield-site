import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// Self-renewing CP service credentials (coordination#33). Every caller reads
// process.env.<KEY> per request, so a renewed token is swapped in there.
export const RENEWED_KEYS = [
  'BLOCKFIELD_CP_STAFF_TOKEN',
  'BLOCKFIELD_CP_MODERATION_TOKEN',
  'BLOCKFIELD_CP_WORKSHOP_TOKEN',
  'BLOCKFIELD_CP_GATE_READ_TOKEN',
  'BLOCKFIELD_CP_GATE_TOKEN',
  'BLOCKFIELD_CP_SETTINGS_TOKEN',
  'BLOCKFIELD_CP_STATS_TOKEN',
] as const

const MAX_LEAD_MS = 7 * 86_400_000
const RETRY_MS = 30_000
const MAX_SLEEP_MS = 3_600_000
// Default sits on a mount prod already has; BLOCKFIELD_CP_STATE_FILE overrides it.
const DEFAULT_STATE = '/blockfield-admin/.site-cp-credentials.json'

type Entry = { token: string; base: string }
type Reply = { status: number; body: any }
export type Deps = {
  call: (method: string, path: string, token: string) => Promise<Reply>
  env: NodeJS.ProcessEnv
  statePath: string
  now: () => number
  log: (message: string) => void
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** ~7 days before expiry, or a quarter of the lifetime for short test credentials. */
export function renewAt(issuedMs: number, expiresMs: number): number {
  return expiresMs - Math.min(MAX_LEAD_MS, (expiresMs - issuedMs) / 4)
}

function readState(path: string): Record<string, Entry> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function update(path: string, change: (state: Record<string, Entry>) => void) {
  const state = readState(path)
  change(state)
  await mkdir(dirname(path), { recursive: true })
  // Unique per write: overlapping deploys share the volume and often the same pid.
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

export const persist = (path: string, key: string, token: string, envToken: string) =>
  update(path, (state) => {
    state[key] = { token, base: sha256(envToken) }
  })

export class Renewer {
  readonly original: Record<string, string> = {}
  private readonly confirmPending = new Set<string>()

  private readonly deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  /**
   * Persisted successors win while they descend from the current env token.
   * Synchronous: after a confirmed renewal the env token is revoked, so no
   * request may run before the swap.
   */
  load() {
    const state = readState(this.deps.statePath)
    for (const key of RENEWED_KEYS) {
      const env = (this.deps.env[key] ?? '').trim()
      this.original[key] = env
      const entry = state[key]
      if (env && entry?.token && entry.base === sha256(env)) {
        this.deps.env[key] = entry.token
        // May be unconfirmed (crash before confirm); confirm is idempotent.
        this.confirmPending.add(key)
      }
    }
  }

  /** One renewal step for one key; returns the delay before the next one. */
  async tick(key: string): Promise<number> {
    const { call, env, now, log } = this.deps
    const token = (env[key] ?? '').trim()
    if (!token) return MAX_SLEEP_MS
    if (this.confirmPending.has(key)) {
      const { status } = await call('POST', '/v2/credentials/renew/confirm', token)
      // 404: nothing pending for this token; 401: the /v2/me check below falls back.
      if ([200, 401, 404].includes(status)) this.confirmPending.delete(key)
      else return RETRY_MS
    }
    const me = await call('GET', '/v2/me', token)
    const envToken = this.original[key] ?? ''
    if (me.status === 401 && envToken && token !== envToken) {
      log(`${key}: persisted CP credential rejected, falling back to the env token`)
      env[key] = envToken
      // Otherwise the next restart would adopt the rejected successor again.
      await update(this.deps.statePath, (state) => {
        delete state[key]
      })
      return 0
    }
    if (me.status !== 200) return RETRY_MS
    // A CP without renewal support (no expiry in /v2/me): check back hourly.
    if (!me.body?.issuedAt || !me.body?.expiresAt) return MAX_SLEEP_MS
    const issuedMs = Date.parse(me.body.issuedAt)
    const expiresMs = Date.parse(me.body.expiresAt)
    if (!(expiresMs > issuedMs)) {
      log(`${key}: CP returned unusable credential dates`)
      return RETRY_MS
    }
    const due = renewAt(issuedMs, expiresMs)
    if (now() < due) return Math.max(1_000, Math.min(MAX_SLEEP_MS, due - now()))
    const renewed = await call('POST', '/v2/credentials/renew', token)
    if (renewed.status !== 201 || typeof renewed.body?.token !== 'string') {
      log(`${key}: CP credential renew status ${renewed.status}`)
      return RETRY_MS
    }
    // Persist before confirm: confirm revokes the old token. A failed write
    // throws and the retry replays the same successor.
    await persist(this.deps.statePath, key, renewed.body.token, envToken)
    env[key] = renewed.body.token
    this.confirmPending.add(key)
    log(`${key}: CP credential renewed, valid until ${renewed.body.expiresAt}`)
    return 0
  }

  /** Sequential over keys so the shared state file never sees concurrent writes. */
  async cycle(): Promise<number> {
    let next = MAX_SLEEP_MS
    for (const key of RENEWED_KEYS) {
      let delay: number
      try {
        delay = await this.tick(key)
      } catch (error) {
        this.deps.log(`${key}: CP credential renewal check failed: ${error}`)
        delay = RETRY_MS
      }
      next = Math.min(next, delay)
    }
    return next
  }
}

let started = false

/** Idempotent; called from the request middleware so it starts with the server. */
export function startCredentialRenewal(env: NodeJS.ProcessEnv = process.env) {
  if (started) return
  started = true
  const base = (env.BLOCKFIELD_CP_URL ?? '').replace(/\/+$/, '').trim()
  if (!base) return
  const renewer = new Renewer({
    env,
    statePath: (env.BLOCKFIELD_CP_STATE_FILE ?? '').trim() || DEFAULT_STATE,
    now: Date.now,
    log: (message) => console.warn(message),
    call: async (method, path, token) => {
      const response = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    },
  })
  const loop = async () => {
    const delay = await renewer.cycle()
    setTimeout(loop, delay).unref()
  }
  renewer.load()
  void loop()
}
