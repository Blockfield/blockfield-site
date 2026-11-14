import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kitFixture } from './kits-fixture.mjs'

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-cp-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Merge with the exact semantics of control-plane main post-#25
 * (cpv2/settings.py `merge`, RFC 7396 JSON Merge Patch): a patch null
 * deletes the key recursively before validation, absent keys are untouched,
 * arrays are replaced wholesale. The only stored-null exception is
 * `fixedModeKits.<mode>` ("kit id or null"): null clears the fixed kit but
 * keeps the explicit entry.
 */
const NULL_VALUED_PARENTS = new Set(['fixedModeKits'])
function merge(base, patch, parent) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && !NULL_VALUED_PARENTS.has(parent)) delete out[key]
    else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    )
      out[key] = merge(out[key], value, key)
    else out[key] = value
  }
  return out
}

/**
 * Narrow mirror of the cpv2/settings.py Strict validators that matter here
 * (control-plane main post-#25): gameplay.lobby allows only pvpEnabled;
 * gunBalance, kits and campaign values must be objects — a patch null
 * deletes before validation, so it never reaches the models; fixedModeKits
 * values are kit ids or null (the stored-null exception); ai-limits scopes
 * hold micros or are absent after a null-delete reset.
 */
function validateNs(namespace, value) {
  if (namespace === 'gameplay') {
    for (const key of Object.keys(value.lobby ?? {}))
      if (key !== 'pvpEnabled') return `gameplay.lobby: unknown key ${key}`
  }
  if (namespace === 'gunBalance') {
    for (const [id, override] of Object.entries(value.overrides ?? {}))
      if (!override || typeof override !== 'object' || Array.isArray(override))
        return `gunBalance.${id}: expected override object`
  }
  if (namespace === 'kits') {
    for (const [id, kit] of Object.entries(value.kits ?? {}))
      if (!kit || typeof kit !== 'object') return `kits.${id}: expected object`
    for (const [mode, target] of Object.entries(value.fixedModeKits ?? {}))
      if (target !== null && typeof target !== 'string')
        return `fixedModeKits.${mode}: expected kit id or null`
  }
  if (namespace === 'campaign') {
    for (const [id, balance] of Object.entries(value.campaignBalance ?? {}))
      if (!balance || typeof balance !== 'object' || Array.isArray(balance))
        return `campaignBalance.${id}: expected object`
  }
  if (namespace === 'ai-limits') {
    for (const scope of ['sessions', 'builders']) {
      const accounts = value[scope]
      if (accounts === undefined) continue
      if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts))
        return `ai-limits.${scope}: expected object`
      for (const [, amount] of Object.entries(accounts))
        if (!Number.isSafeInteger(amount)) return `ai-limits.${scope}: expected micros`
    }
  }
  return null
}

const defaultGunCatalog = () => ({
  schema: 1,
  revision: 0,
  fields: {
    type: 'object',
    nullable: false,
    fields: { draw_time: { type: 'number', nullable: false, min: 0, max: 60 } },
  },
  guns: ['tacz:m4a1', 'tacz:ak47'].map((id) => ({
    id,
    data: id,
    name: 'gun',
    type: 'rifle',
    defaults: { draw_time: 0.32 },
    effective: { draw_time: 0.32 },
    warnings: [],
  })),
})

/** Fake of the CP v2 settings contract on control-plane main (post-#21), plus presence. */
export function fakeCp(opts = {}) {
  const known = new Set([
    'gameplay',
    'rooms',
    'deathmatch',
    'classLocks',
    'campaign',
    'parcool',
    'gunBalance',
    'kits',
    'disabledMapIds',
    'ai-limits',
    'workshop-ai',
  ])
  const state = new Map()
  const seen = []
  const idem = new Map()
  const server = http.createServer((req, res) => {
    const answer = (code, data) => {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(data))
    }
    if (req.headers.authorization !== 'Bearer settings-t')
      return answer(401, { error: 'unauthenticated' })
    if (req.url.startsWith('/v2/rooms')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const presence = {
          rooms: [],
          ...(opts.presenceExtra ?? {}),
          gunCatalog: opts.gunCatalog ?? defaultGunCatalog(),
          kitCatalog: opts.kitCatalog ?? kitFixture(),
          applied: opts.applied ?? { revision: 0, attemptedRevision: 0, errors: [] },
        }
        return answer(200, {
          initialized: true,
          reportedAt: new Date().toISOString(),
          presence,
        })
      })
      return
    }
    const match = req.url.match(/^\/v2\/settings\/([^/]+)\/([^/?]+)(\/rollback)?/)
    if (!match) return answer(404, { error: 'not_found' })
    const [, namespace, target, rollback] = match.map((s) => (s ? decodeURIComponent(s) : s))
    if (!known.has(namespace)) return answer(404, { error: 'unknown_namespace' })
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const key = `${namespace}/${target}`
      const payload = body ? JSON.parse(body) : {}
      if (req.method === 'GET') {
        if (opts.onGet?.(namespace) === false) return answer(500, { error: 'internal' })
        const current = state.get(key)
        if (!current)
          return answer(200, { initialized: false, revision: 0, value: {}, hash: 'none' })
        return answer(200, {
          initialized: true,
          revision: current.revision,
          value: current.value,
          hash: 'hash',
        })
      }
      seen.push([namespace, payload])
      if (opts.failPatch === 500 && !rollback) return answer(500, { error: 'internal' })
      if (opts.failNamespaces?.includes(namespace) && !rollback)
        return answer(500, { error: 'internal' })
      const idemKey = `${key}/${payload.idempotencyKey ?? ''}`
      if (req.method === 'PATCH' || (req.method === 'POST' && rollback)) {
        if (opts.patchDelayMs)
          await new Promise((resolve) => setTimeout(resolve, opts.patchDelayMs))
        if (payload.patch && payload.patch.$fail === '500')
          return answer(500, { error: 'internal' })
        if (payload.patch && payload.patch.$fail === 'timeout') {
          req.socket.destroy()
          return
        }
        const current = state.get(key) ?? { revision: 0, value: {}, history: [] }
        if (idem.has(idemKey)) {
          const prev = idem.get(idemKey)
          if (JSON.stringify(prev.body) === body) return answer(202, prev.receipt)
          return answer(409, { error: 'idempotency_conflict' })
        }
        if (payload.expectedRevision !== current.revision)
          return answer(409, { error: 'revision_conflict' })
        let candidate
        if (rollback) {
          candidate = current.history[payload.revision - 1]
          if (candidate === undefined) return answer(404, { error: 'revision_not_found' })
          candidate = JSON.parse(JSON.stringify(candidate))
        } else {
          candidate = merge(current.value, payload.patch)
          const invalid = validateNs(namespace, candidate)
          if (invalid) return answer(422, { error: 'invalid_settings', detail: invalid })
        }
        const receipt = { operationId: `op-${seen.length}`, revision: current.revision + 1 }
        idem.set(idemKey, { body, receipt })
        state.set(key, {
          revision: receipt.revision,
          value: candidate,
          history: [...current.history, JSON.parse(JSON.stringify(candidate))],
        })
        if (opts.commitThenHang === namespace) {
          opts.commitThenHang = ''
          req.socket.destroy()
          return
        }
        return answer(202, receipt)
      }
      return answer(405, { error: 'method_not_allowed' })
    })
  })
  return { server, seen }
}

export async function withCp(t, fn, opts = {}) {
  const { server, seen } = fakeCp(opts)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = temp(t)
  try {
    process.env.BLOCKFIELD_CP_URL = `http://127.0.0.1:${server.address().port}`
    process.env.BLOCKFIELD_CP_SETTINGS_TOKEN = 'settings-t'
    process.env.BLOCKFIELD_CP_CONSUMER_ID = 'game'
    await fn(dir, seen)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    delete process.env.BLOCKFIELD_CP_URL
    delete process.env.BLOCKFIELD_CP_SETTINGS_TOKEN
    delete process.env.BLOCKFIELD_CP_CONSUMER_ID
  }
}
